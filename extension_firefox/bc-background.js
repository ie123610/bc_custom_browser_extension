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
 * 原生消息传递（Native Messaging）封装
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
    const finalUrl = downloadItem.finalUrl || downloadItem.url;
    const referrerUrl = downloadItem.referrer || '';

    const rawFilename = downloadItem.filename || '';
    const cleanFilename = rawFilename.replace(/^.*[\\/]/, '');

    const targetUrls = Array.from(new Set([finalUrl, originalUrl, referrerUrl].filter(Boolean)));

    // 调试输出：打印当前下载任务的原始 URL 与最终重定向 URL
    console.group("[下载任务传递信息]");
    console.log("-> 原始请求 URL (originalUrl):", originalUrl);
    console.log("-> 重定向终点 URL (finalUrl):", finalUrl);
    console.log("-> 来源页面 (referrerUrl):", referrerUrl);
    console.log("-> 收集到的所有 Cookie 查询 Target URLs:", targetUrls);

    var cManager = new CookieManager();
    cManager.getCookiesForUrls(targetUrls, function (results) {
        const cookieString = (results && results[0]) || '';

        console.log("-> 最终生成的 Cookie 字符串:", cookieString || "(空)");

        const payload = {
          action: "Download",
          link: finalUrl,
          name: cleanFilename,
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
 * 辅助逻辑：校验文件名或 URL 的扩展名是否在拦截白名单中
 */
function isExtensionMatching(targetString, filterString) {
  if (!targetString) return false;

  const cleanStr = targetString.split('?')[0].split('#')[0].replace(/^.*[\\/]/, '');
  const extMatch = cleanStr.match(/\.([a-zA-Z0-9]+)$/);
  const fileExt = extMatch ? extMatch[1].toLowerCase() : "";

  const filterExtArray = (filterString || "")
    .toLowerCase()
    .split(';')
    .map(ext => ext.trim().replace(/^\./, ''))
    .filter(Boolean);

  return Boolean(fileExt && filterExtArray.includes(fileExt));
}

/**
 * 执行接管推送到比特彗星并销毁浏览器内置任务
 */
function executeFirefoxIntercept(item) {
  if (processedDownloadIds.has(item.id)) return;
  processedDownloadIds.add(item.id);

  sendToBitComet(item).then((success) => {
    if (success) {
      try {
        extAPI.downloads.cancel(item.id, () => {
          extAPI.downloads.erase({ id: item.id });
        });
      } catch (err) {
        console.error("取消下载任务失败:", err);
      }
    } else {
      processedDownloadIds.delete(item.id);
    }
  });
}

/**
 * 第一层 onCreated 快速拦截管线 (针对静态 URL 直链)
 */
function handleFirefoxOnCreated(item) {
  if (processedDownloadIds.has(item.id)) return;

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = result.bPluginEnabled !== false;
    if (!isEnabled) return;

    const filterString = result.sExtFilterList || "";
    const cleanFilename = (item.filename || "").replace(/^.*[\\/]/, '');

    const fnMatched = isExtensionMatching(cleanFilename, filterString);
    const urlMatched = isExtensionMatching(item.url, filterString);

    if (fnMatched || urlMatched) {
      executeFirefoxIntercept(item);
    }
  });
}

/**
 * 第二层 onChanged 动态拦截管线 (针对重定向及动态生成文件名)
 */
function handleFirefoxOnChanged(delta) {
  if (!delta.filename || !delta.filename.current) return;
  if (processedDownloadIds.has(delta.id)) return;

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = result.bPluginEnabled !== false;
    if (!isEnabled) return;

    const fullPath = delta.filename.current || "";
    const cleanFilename = fullPath.replace(/^.*[\\/]/, '');
    const filterString = result.sExtFilterList || "";

    if (isExtensionMatching(cleanFilename, filterString)) {
      extAPI.downloads.search({ id: delta.id }, (items) => {
        if (items && items.length > 0) {
          executeFirefoxIntercept(items[0]);
        }
      });
    }
  });
}

/**
 * 注册 Firefox 拦截事件
 */
if (extAPI.downloads.onCreated) {
  extAPI.downloads.onCreated.addListener(handleFirefoxOnCreated);
}
if (extAPI.downloads.onChanged) {
  extAPI.downloads.onChanged.addListener(handleFirefoxOnChanged);
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

	console.group("[右键下载管线] 触发右键下载");
	console.log("-> 提取到的目标 URL (targetUrl):", targetUrl);
	console.log("-> 当前页面来源 URL (refererUrl):", refererUrl);
	console.log("-> 原始 onClicked info 对象:", info);

	if (info.pageUrl === "about:downloads") {
		console.log("-> 检测到在 about:downloads 页面触发，尝试检索历史关联 Referrer...");
		extAPI.downloads.search(
			{ url: targetUrl, orderBy: ['-startTime'], limit: 1 },
			function(data) {
				if (data && data.length > 0) {
					refererUrl = data[0].referrer || refererUrl;
					console.log("-> 从下载历史中补全获得的 Referrer:", refererUrl);
				} else {
					console.log("-> 未在下载历史中检索到匹配项目，维持默认 Referer");
				}
				console.groupEnd();
				ForceTriggerDownload(targetUrl, refererUrl);
			}
		);
	} else {
		console.groupEnd();
		ForceTriggerDownload(targetUrl, refererUrl);
	}
}

/**
 * 强制唤醒原生下载流
 */
function ForceTriggerDownload(link, refererUrl) {
	console.group("[右键下载管线] 唤醒原生 downloads.download");
	console.log("-> 请求 URL:", link);
	console.log("-> 关联 Referer:", refererUrl || "(无)");

	extAPI.downloads.download({
		url: link,
		saveAs: false
	}, (downloadId) => {
		if (extAPI.runtime.lastError) {
			console.error("-> 触发原生下载失败:", extAPI.runtime.lastError.message);
		} else {
			console.log(`-> 成功触发原生下载任务 (Task ID: ${downloadId})，等待 onCreated/onChanged 拦截管线接管...`);
		}
		console.groupEnd();
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
 * 初始化右键菜单
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
 * 切换工具栏图标显示
 */
async function UpdateBrowserActionIcon(bPluginEnabled) {
	if (bPluginEnabled == null) {
		let settingValues = await new Promise((res) => extAPI.storage.local.get(["bPluginEnabled"], res));
		bPluginEnabled = settingValues && settingValues.bPluginEnabled !== false;
	}

	var iconPath = bPluginEnabled ? "images/icon19_normal.png" : "images/icon19_disabled.png";
	const actionAPI = extAPI.action || extAPI.browserAction;
	if (actionAPI && actionAPI.setIcon) {
		actionAPI.setIcon({ path: iconPath });
	}
}

/**
 * 注册与外部 UI 通信的消息监听器
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
			ForceTriggerDownload(message.link, message.referurl);
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