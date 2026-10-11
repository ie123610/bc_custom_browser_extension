// Firefox 插件

const BITCOMET_NATIVE_HOST = 'org.custom.bitcomet_bridge';
const contextMenuId = "BitCometContextMenu";

// 跨浏览器 API 命名空间兼容
const extAPI = typeof browser !== 'undefined' ? browser : chrome;

// 记录已处理或正在处理的下载 ID，防止重复捕获
const processedDownloadIds = new Set();

// 全局缓存配置状态
const storageCache = {
	bPluginEnabled: true,
	sExtFilterList: ""
};

/**
 * 移植自 Xdown 并升级为多源去重合并的 CookieManager
 */
function CookieManager()
{
}

CookieManager.prototype.getCookiesForUrl = function(url, callback) 
{
    this.getCookiesForUrls([url], function (result) {
        callback(result[0]);
    });
}

CookieManager.prototype.getCookiesForUrls = function(
    urls, callback)
{
    var remained = urls.length;
    var cookieMap = new Map();

    for (var i = 0; i < urls.length; ++i) {
        extAPI.cookies.getAll(
            { 'url': urls[i] },
            function (cookies) {
                if (cookies) {
                    cookies.forEach(function (c) {
                        if (c && c.name) {
                            cookieMap.set(c.name, c.value);
                        }
                    });
                }
                if (!--remained) {
                    var cookieList = Array.from(cookieMap.entries()).map(function (entry) {
                        return entry[0] + "=" + entry[1];
                    });
                    var cookiesString = cookieList.join('; ');
                    callback([cookiesString]);
                }
            });
    }
}

/**
 * 原生消息传递（Native Messaging）跨浏览器 Promise / Callback 兼容封装
 */
function sendNativeMessageCompat(host, payload) {
    return new Promise((resolve) => {
        try {
            var p = extAPI.runtime.sendNativeMessage(host, payload, (response) => {
                if (extAPI.runtime.lastError) {
                    console.error("[Native Messaging] 通信错误:", extAPI.runtime.lastError.message);
                    resolve({ error: extAPI.runtime.lastError });
                } else {
                    resolve({ response: response });
                }
            });
            // 兼容 Firefox 原生返回 Promise 的调用方式
            if (p && typeof p.then === 'function') {
                p.then((res) => resolve({ response: res }))
                 .catch((err) => resolve({ error: err }));
            }
        } catch (e) {
            resolve({ error: e });
        }
    });
}

/**
 * 获取目标 URL Cookie 并透退给比特彗星 Native 宿主程序
 */
function sendToBitComet(downloadItem) {
  return new Promise((resolve) => {
    const originalUrl = downloadItem.url || '';
    const finalUrl = downloadItem.finalUrl || downloadItem.url; // 优先取重定向后的终点地址
    const referrerUrl = downloadItem.referrer || '';

    // 剥离可能包含的路径前缀（兼容 Windows '\' 与 Unix/Mac '/'），仅获取纯文件名
    const rawFilename = downloadItem.filename || '';
    const cleanFilename = rawFilename.replace(/^.*[\\/]/, '');

    // 收集所有关联的 URL 来源（去重且排除空字符串）
    const targetUrls = Array.from(new Set([finalUrl, originalUrl, referrerUrl].filter(Boolean)));

    // 调试输出：打印当前下载任务的原始 URL 与最终重定向 URL
    console.group("[下载任务传递信息]");
    console.log("-> 原始请求 URL (originalUrl):", originalUrl);
    console.log("-> 重定向终点 URL (finalUrl):", finalUrl);
    console.log("-> 来源页面 (referrerUrl):", referrerUrl);
    console.log("-> 收集到的所有 Cookie 查询 Target URLs:", targetUrls);

    // 调用升级后的 CookieManager 获取多源合并后的 Cookie
    var cManager = new CookieManager();
    cManager.getCookiesForUrls(targetUrls, function (results) {
        const cookieString = (results && results[0]) || '';

        console.log("-> 最终生成的 Cookie 字符串:", cookieString || "(空)");

        const payload = {
          action: "Download",
          link: finalUrl,
          name: cleanFilename, // 传入剥离路径后的纯文件名
          cookie: cookieString,
          referurl: referrerUrl,
          user_agent: navigator.userAgent
        };

        console.log("-> 发送给 Native Host 的完整 Payload 数据:", JSON.stringify(payload, null, 2));
        console.groupEnd();

        sendNativeMessageCompat(BITCOMET_NATIVE_HOST, payload).then((res) => {
          if (res.error) {
            console.error("[下载任务传递信息] 调用 Native Host 失败:", res.error.message || res.error);
            resolve(false);
            return;
          }

          var response = res.response;
          if (response && response.status === "ok") {
            console.log("[下载任务传递信息] 比特彗星响应成功:", response);
            resolve(true);
          } else {
            console.error("[下载任务传递信息] 比特彗星响应错误，详细原因:", response ? response.message : "未知响应格式");
            resolve(false);
          }
        });
    });
  });
}

/**
 * Chrome / Edge 专属拦截处理函数
 */
function handleChromeDownloadIntercept(item, suggest) {
  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = result.bPluginEnabled !== false; // 默认开启

    if (!isEnabled) {
      if (suggest) suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    const filename = item.filename || "";
    const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
    const fileExt = extMatch ? extMatch[1].toLowerCase() : "";

    const filterString = (result.sExtFilterList || "").toLowerCase();
    const filterExtArray = filterString
      .split(';')
      .map(ext => ext.trim().replace(/^\./, ''))
      .filter(Boolean);

    const isMatch = fileExt && filterExtArray.includes(fileExt);

    if (!isMatch) {
      console.log(`[下载任务拦截] 文件名 "${filename}" 的扩展名 (.${fileExt}) 未在拦截列表中，放行交由浏览器原生下载。`);
      if (suggest) suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    console.log(`[下载任务拦截] 文件名 "${filename}" 匹配接管扩展名 (.${fileExt})，准备推送到比特彗星...`);
    sendToBitComet(item).then((success) => {
      if (success) {
        try {
          extAPI.downloads.cancel(item.id, () => {
            extAPI.downloads.erase({ id: item.id });
            console.log(`[下载任务传递信息] 已自动接管并清除内置下载 (ID: ${item.id})`);
          });
        } catch (err) {
          console.error("[下载任务传递信息] 取消下载任务失败:", err);
        }
      } else {
        console.warn("[下载任务传递信息] 调起比特彗星失败，回退为浏览器原生下载");
        if (suggest) suggest({ filename: item.filename, conflictAction: 'uniquify' });
      }
    });
  });
}

/**
 * 辅助逻辑：校验文件名或 URL 的扩展名是否在拦截白名单中
 */
function isExtensionMatching(targetString, filterString) {
  if (!targetString) {
    console.log("  └─ [匹配检查] 待校验目标为空字符串，比对跳过。");
    return false;
  }
  // 清理路径前缀和 URL 参数
  const cleanStr = targetString.split('?')[0].split('#')[0].replace(/^.*[\\/]/, '');
  const extMatch = cleanStr.match(/\.([a-zA-Z0-9]+)$/);
  const fileExt = extMatch ? extMatch[1].toLowerCase() : "";

  const filterExtArray = (filterString || "")
    .toLowerCase()
    .split(';')
    .map(ext => ext.trim().replace(/^\./, ''))
    .filter(Boolean);

  const matched = Boolean(fileExt && filterExtArray.includes(fileExt));
  console.log(`  └─ [匹配检查] 原始目标: "${targetString}" | 提取基名: "${cleanStr}" | 提取后缀: ".${fileExt}" | 拦截白名单: [${filterExtArray.join(', ')}] | 比对结果: ${matched}`);
  return matched;
}

/**
 * 通用执行接管推送到比特彗星的逻辑
 */
function executeFirefoxIntercept(item, label) {
  if (processedDownloadIds.has(item.id)) {
    console.log(`[${label}] 下载任务 ID: ${item.id} 已经在处理队列中，忽略重复唤醒。`);
    return;
  }
  processedDownloadIds.add(item.id);

  console.log(`[${label}] 命中接管扩展名，准备推送到比特彗星... (ID: ${item.id})`);
  sendToBitComet(item).then((success) => {
    if (success) {
      try {
        extAPI.downloads.cancel(item.id, () => {
          extAPI.downloads.erase({ id: item.id });
          console.log(`[${label}] 已自动接管并清除内置下载 (ID: ${item.id})`);
        });
      } catch (err) {
        console.error(`[${label}] 取消下载任务失败:`, err);
      }
    } else {
      console.warn(`[${label}] 调起比特彗星失败，放行恢复浏览器原生下载`);
      processedDownloadIds.delete(item.id);
    }
  });
}

/**
 * Firefox 专属：第一层 onCreated 快速拦截管线 (针对静态 URL 直链)
 */
function handleFirefoxOnCreated(item) {
  console.group(`[Firefox 捕获管线] onCreated 事件触发 (Task ID: ${item.id})`);
  console.log("-> 接收到的原始 DownloadItem:", item);

  if (processedDownloadIds.has(item.id)) {
    console.log("-> Task ID 已包含在 processedDownloadIds 集合中，跳过执行。");
    console.groupEnd();
    return;
  }

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = result.bPluginEnabled !== false;
    console.log("-> 插件启用状态 (bPluginEnabled):", isEnabled);
    console.log("-> 拦截扩展名白名单 (sExtFilterList):", result.sExtFilterList || "(为空)");

    if (!isEnabled) {
      console.log("-> 插件已被关闭，跳过拦截管线。");
      console.groupEnd();
      return;
    }

    const filterString = result.sExtFilterList || "";
    const cleanFilename = (item.filename || "").replace(/^.*[\\/]/, '');

    console.log("-> 开始比对 filename 扩展名...");
    const fnMatched = isExtensionMatching(cleanFilename, filterString);
    console.log("-> 开始比对 URL 扩展名...");
    const urlMatched = isExtensionMatching(item.url, filterString);

    if (fnMatched || urlMatched) {
      console.log("-> onCreated 成功捕获静态任务，触发下载接管！");
      console.groupEnd();
      executeFirefoxIntercept(item, "Firefox onCreated 极速拦截");
    } else {
      console.log("-> onCreated 未能通过扩展名比对，等待 onChanged 阶段异步捕获。");
      console.groupEnd();
    }
  });
}

/**
 * Firefox 专属：第二层 onChanged 动态拦截管线 (针对重定向及动态生成文件名)
 */
function handleFirefoxOnChanged(delta) {
  console.group(`[Firefox 捕获管线] onChanged 事件触发 (Task ID: ${delta.id})`);
  console.log("-> 接收到的属性变动 Delta:", delta);

  if (!delta.filename || !delta.filename.current) {
    console.log("-> 本次 onChanged 不包含 filename 变更或 current 属性，忽略处理。");
    console.groupEnd();
    return;
  }

  if (processedDownloadIds.has(delta.id)) {
    console.log("-> Task ID 已包含在 processedDownloadIds 集合中，忽略处理。");
    console.groupEnd();
    return;
  }

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = result.bPluginEnabled !== false;
    console.log("-> 插件启用状态 (bPluginEnabled):", isEnabled);
    console.log("-> 拦截扩展名白名单 (sExtFilterList):", result.sExtFilterList || "(为空)");

    if (!isEnabled) {
      console.log("-> 插件已被关闭，跳过拦截管线。");
      console.groupEnd();
      return;
    }

    const fullPath = delta.filename.current || "";
    const cleanFilename = fullPath.replace(/^.*[\\/]/, '');
    const filterString = result.sExtFilterList || "";

    console.log("-> onChanged 解析到的最新 filename:", fullPath);
    console.log("-> 开始比对 onChanged 文件名扩展名...");
    const isMatched = isExtensionMatching(cleanFilename, filterString);

    if (isMatched) {
      console.log("-> onChanged 成功捕获变动文件名，查询完整的 DownloadItem 并准备接管...");
      extAPI.downloads.search({ id: delta.id }, (items) => {
        if (items && items.length > 0) {
          console.groupEnd();
          executeFirefoxIntercept(items[0], "Firefox onChanged 动态拦截");
        } else {
          console.warn("-> 未能检索到指定的 DownloadItem (ID:", delta.id, ")");
          console.groupEnd();
        }
      });
    } else {
      console.log("-> onChanged 变动的文件名不在拦截白名单中，放行给 Firefox 原生下载。");
      console.groupEnd();
    }
  });
}

/**
 * 核心拦截事件注册（区分 Chrome 与 Firefox 专属拦截管线）
 */
if (extAPI.downloads.onDeterminingFilename) {
  console.log("[系统初始化] 检测到支持 onDeterminingFilename API，已注册 Chrome/Edge 拦截管线。");
  extAPI.downloads.onDeterminingFilename.addListener((item, suggest) => {
    handleChromeDownloadIntercept(item, suggest);
    return true;
  });
} else {
  console.log("[系统初始化] 未检测到 onDeterminingFilename API，准备注册 Firefox 双层拦截管线 (onCreated + onChanged)...");
  if (extAPI.downloads.onCreated) {
    console.log("[系统初始化] 已注册 extAPI.downloads.onCreated 监听器。");
    extAPI.downloads.onCreated.addListener((item) => {
      handleFirefoxOnCreated(item);
    });
  } else {
    console.warn("[系统初始化] 警告: 当前环境不支持 extAPI.downloads.onCreated !");
  }

  if (extAPI.downloads.onChanged) {
    console.log("[系统初始化] 已注册 extAPI.downloads.onChanged 监听器。");
    extAPI.downloads.onChanged.addListener((delta) => {
      handleFirefoxOnChanged(delta);
    });
  } else {
    console.warn("[系统初始化] 警告: 当前环境不支持 extAPI.downloads.onChanged !");
  }
}

/**
 * 设置插件开关状态，同步修改存储与图标 UI
 */
function SetPluginEnabled(bEnabled) {
	extAPI.storage.local.set({ bPluginEnabled: bEnabled });
	UpdateBrowserActionIcon(bEnabled);
}

/**
 * 右键菜单点击处理逻辑：强制转化为原生下载任务
 */
function onStartupDownload(info, tab) {
	let targetUrl = info.linkUrl || info.srcUrl || info.pageUrl;
	let refererUrl = info.pageUrl || "";

	// 兼容 Chrome 的 chrome://downloads/ 与 Firefox 的 about:downloads
	if (info.pageUrl === "chrome://downloads/" || info.pageUrl === "about:downloads") {
		extAPI.downloads.search(
			{ url: targetUrl, orderBy: ['-startTime'], limit: 1 },
			function(data) {
				if (data && data.length > 0) {
					refererUrl = data[0].referrer || refererUrl;
				}
				ForceTriggerChromeDownload(targetUrl, refererUrl);
			}
		);
	} else {
		ForceTriggerChromeDownload(targetUrl, refererUrl);
	}
}

/**
 * 通过调用 extAPI.downloads.download 强制唤醒下载流
 */
function ForceTriggerChromeDownload(link, refererUrl) {
	console.log("[下载任务传递信息] 右键强制重定向为原生下载流程:", link);
	extAPI.downloads.download({
		url: link,
		saveAs: false
	}, (downloadId) => {
		if (extAPI.runtime.lastError) {
			console.error("[下载任务传递信息] 触发原生下载失败:", extAPI.runtime.lastError.message);
		} else {
			console.log(`[下载任务传递信息] 成功触发临时原生下载任务 (ID: ${downloadId})，等待拦截管线捕获文件名...`);
		}
	});
}

/**
 * 获取客户端配置（例如比特彗星内部设定的扩展名列表）
 */
function InvokeGetHostConfig() {
	sendNativeMessageCompat(BITCOMET_NATIVE_HOST, { action: "GetConfig" }).then((res) => {
		if (res.error) {
			console.error("[BitComet Native 通信错误] 无法与客户端建立连接: " + (res.error.message || res.error));
		} else if (res.response) {
			var response = res.response;
			console.log("Received Config: " + JSON.stringify(response));
			extAPI.storage.local.get(["sExtFilterList"], (settingValues) => {
				if (typeof settingValues == 'undefined' || settingValues.sExtFilterList != response.ext_list) {
					extAPI.storage.local.set({ sExtFilterList: response.ext_list });
				}
			});
		}
	});
}

/**
 * 调起比特彗星客户端主界面
 */
function InvokeLaunchProgram() {
	sendNativeMessageCompat(BITCOMET_NATIVE_HOST, { action: "Launch_Program" }).then((res) => {
		if (res.error) {
			console.error("LaunchProgram Error: " + (res.error.message || res.error));
		} else if (res.response && res.response.status !== "ok") {
			console.error("LaunchProgram Failed: " + JSON.stringify(res.response));
		}
	});
}

/**
 * 初始化右键菜单：支持链接、图片、音频和视频等多种右键场景
 */
function CreateContextMenu() {
	extAPI.contextMenus.removeAll(function() {
		extAPI.contextMenus.create({
			id: contextMenuId,
			type: "normal",
			title: extAPI.i18n.getMessage("context_menu_title"),
			contexts: ["link", "image", "audio", "video"],
			enabled: true
		});
		extAPI.contextMenus.onClicked.addListener((info, tab) => {
			if (info.menuItemId == contextMenuId) {
				onStartupDownload(info, tab);
			}
		});
	});
}

function UpdateContextMenuTitle(title) {
	extAPI.contextMenus.update(contextMenuId, { title: title });
}

/**
 * 根据插件开/关状态动态切换工具栏上的显示图标
 */
async function UpdateBrowserActionIcon(bPluginEnabled) {
	if (bPluginEnabled == null) {
		let settingValues = await new Promise((res) => extAPI.storage.local.get(["bPluginEnabled"], res));
		bPluginEnabled = settingValues && settingValues.bPluginEnabled !== false;
	}

	var iconPath = bPluginEnabled ? "images/icon19_normal.png" : "images/icon19_disabled.png";
	// 兼顾 Chrome MV3 (action) 与 Firefox / MV2 (browserAction)
	const actionAPI = extAPI.action || extAPI.browserAction;
	if (actionAPI && actionAPI.setIcon) {
		actionAPI.setIcon({ path: iconPath });
	}
}

/**
 * 注册与外部 UI（Popup 弹窗页面）通信的消息监听器
 */
function RegisterEventListener() {
	if (extAPI.windows && extAPI.windows.onFocusChanged) {
		extAPI.windows.onFocusChanged.addListener(function(windowId) {
			if (extAPI.windows.WINDOW_ID_NONE != windowId)
				InvokeGetHostConfig();
		});
	}

	extAPI.runtime.onMessage.addListener(function(message, sender, response) {
		if (message.name == "CaptureDownload") {
			ForceTriggerChromeDownload(message.link, message.referurl);
		} else if (message.name == "CheckHostConfig") {
			InvokeGetHostConfig();
		} else if (message.name === 'setContextMenuTitle') {
			UpdateContextMenuTitle(message.title);
		} else if (message.name == "setPluginEnable") {
			SetPluginEnabled(message.value);
		} else if (message.name == "launchProgram") {
			InvokeLaunchProgram();
		}
		if (typeof response === 'function') {
			response(true);
		}
	});
}

/**
 * 仅在插件首次安装/更新/加载时进行一次 Native 通信预检
 */
if (extAPI.runtime.onInstalled) {
	extAPI.runtime.onInstalled.addListener(() => {
		InvokeGetHostConfig();
	});
}

function Init() {
	CreateContextMenu();
	UpdateBrowserActionIcon();
	RegisterEventListener();
}

Init();