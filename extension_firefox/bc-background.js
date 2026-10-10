// Firefox / Chrome 双核兼容插件

const BITCOMET_NATIVE_HOST = 'org.custom.bitcomet_bridge';
const contextMenuId = "BitCometContextMenu";

// 跨浏览器 API 命名空间兼容
const extAPI = typeof browser !== 'undefined' ? browser : chrome;

// 全局缓存配置状态
const storageCache = {
	bPluginEnabled: true,
	sExtFilterList: ""
};

/**
 * 移植自 Xdown 并升级为多源去重、域优先及长度限制合并的 CookieManager
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
    var rawResults = new Array(urls.length);

    // 1. 按传入的 URL 数组顺序独立收集 Cookie 结果
    for (var i = 0; i < urls.length; ++i) {
        extAPI.cookies.getAll(
            { 'url': urls[i] },
            function (index, cookies) {
                rawResults[index] = cookies || [];
                if (!--remained) {
                    var cookieMap = new Map();

                    // 2. 逆序合并（倒序遍历使优先级最高的域名/URL 后写入，从而覆盖低优先级的同名 Cookie）
                    for (var j = rawResults.length - 1; j >= 0; --j) {
                        var currentList = rawResults[j];
                        for (var k = 0; k < currentList.length; ++k) {
                            var c = currentList[k];
                            if (c && c.name) {
                                cookieMap.set(c.name, c.value);
                            }
                        }
                    }

                    // 3. 构建 Cookie 键值对列表
                    var cookieList = Array.from(cookieMap.entries()).map(function (entry) {
                        return entry[0] + "=" + entry[1];
                    });

                    // 4. 应用 Cookie 字符串安全长度上限限制（防止 HTTP 431 / Header Too Large）
                    var MAX_COOKIE_LENGTH = 4096; // 设定 4KB 安全上限
                    var resultList = [];
                    var currentLength = 0;

                    for (var m = 0; m < cookieList.length; ++m) {
                        var item = cookieList[m];
                        var itemLength = item.length + (resultList.length > 0 ? 2 : 0); // 包含 '; ' 分隔符长度
                        if (currentLength + itemLength > MAX_COOKIE_LENGTH) {
                            console.warn("[CookieManager] Cookie 总体积超过安全上限 (" + MAX_COOKIE_LENGTH + " B)，已安全截断后续字段。");
                            break;
                        }
                        resultList.push(item);
                        currentLength += itemLength;
                    }

                    var cookiesString = resultList.join('; ');
                    callback([cookiesString]);
                }
            }.bind(this, i));
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

    // 按优先级排列查询 Target URLs（下标 0 优先级最高：finalUrl -> originalUrl -> referrerUrl）
    const targetUrls = Array.from(new Set([finalUrl, originalUrl, referrerUrl].filter(Boolean)));

    // 调试输出：打印当前下载任务的原始 URL 与最终重定向 URL
    console.group("[下载任务传递信息]");
    console.log("-> 原始请求 URL (originalUrl):", originalUrl);
    console.log("-> 重定向终点 URL (finalUrl):", finalUrl);
    console.log("-> 来源页面 (referrerUrl):", referrerUrl);
    console.log("-> 收集到的所有 Cookie 查询 Target URLs (按优先级排列):", targetUrls);

    // 调用升级后的 CookieManager 获取多源合并后的 Cookie
    var cManager = new CookieManager();
    cManager.getCookiesForUrls(targetUrls, function (results) {
        const cookieString = (results && results[0]) || '';

        console.log("-> 最终生成的 Cookie 字符串:", cookieString || "(空)");

        const payload = {
          action: "Download",
          link: finalUrl,
          name: downloadItem.filename, // 传入浏览器解析出的精准文件名
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
 * 拦截核心处理逻辑
 */
function handleDownloadIntercept(item, suggest) {
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
 * 核心拦截事件注册（跨浏览器兼容）
 */
if (extAPI.downloads.onDeterminingFilename) {
  // Chrome / Edge 逻辑
  extAPI.downloads.onDeterminingFilename.addListener((item, suggest) => {
    handleDownloadIntercept(item, suggest);
    return true;
  });
} else if (extAPI.downloads.onCreated) {
  // Firefox 兼容逻辑
  extAPI.downloads.onCreated.addListener((item) => {
    handleDownloadIntercept(item, null);
  });
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