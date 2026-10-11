// Chrome 插件

const BITCOMET_NATIVE_HOST = 'org.custom.bitcomet_bridge';
const contextMenuId = "BitCometContextMenu";

// 全局缓存配置状态
const storageCache = {
	bPluginEnabled: false,
	sExtFilterList: ""
};

/**
 * 检查 URL 是否符合跳过接管的特殊协议（如内存数据流、本地扩展、脚本等）
 */
function shouldSkipIntercept(url) {
  if (!url) return true;

  const skipProtocols = [
    'blob:',
    'data:',
    'javascript:',
    'chrome-extension:',
    'moz-extension:',
    'about:'
  ];

  return skipProtocols.some(protocol => url.startsWith(protocol));
}

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
        chrome.cookies.getAll(
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
 * 获取目标 URL Cookie 并透退给比特彗星 Native 宿主程序
 */
function sendToBitComet(downloadItem) {
  return new Promise((resolve) => {
    const originalUrl = downloadItem.url || '';
    const finalUrl = downloadItem.finalUrl || downloadItem.url; // 优先取重定向后的终点地址
    const referrerUrl = downloadItem.referrer || '';

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
          name: downloadItem.filename, // 传入 Chrome 解析出的精准文件名
          cookie: cookieString,
          referurl: referrerUrl,
          user_agent: navigator.userAgent
        };

        console.log("-> 发送给 Native Host 的完整 Payload 数据:", JSON.stringify(payload, null, 2));
        console.groupEnd();

        chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST, payload, (response) => {
          // 1. 检查是否存在管道断开等通信级错误
          if (chrome.runtime.lastError) {
            console.error("[下载任务传递信息] 调用 Native Host 失败:", chrome.runtime.lastError.message);
            resolve(false);
            return;
          }

          // 2. 检查 Native Host 返回的业务状态
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
 * 核心拦截：接管下载文件名确定事件，增加扩展名过滤比对机制
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 校验协议：若是 blob: / data: 等特殊协议，直接放行交由浏览器处理
  const targetUrl = item.finalUrl || item.url || '';
  if (shouldSkipIntercept(targetUrl)) {
    console.log(`[下载任务拦截] 检测到特殊协议 URL "${targetUrl}"，直接放行交由浏览器处理。`);
    suggest({ filename: item.filename, conflictAction: 'uniquify' });
    return;
  }

  // 读取插件使能状态及允许接管的扩展名配置列表
  chrome.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = Boolean(result.bPluginEnabled); // 默认不开启（首次未设定时为 false）

    // 1. 若插件被禁用，直接放行恢复原生下载
    if (!isEnabled) {
      suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    // 2. 提取文件名扩展名并与从 Native Host 获取的配置进行比对校验
    const filename = item.filename || "";
    const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
    const fileExt = extMatch ? extMatch[1].toLowerCase() : "";

    const filterString = (result.sExtFilterList || "").toLowerCase();
    const filterExtArray = filterString
      .split(';')
      .map(ext => ext.trim().replace(/^\./, ''))
      .filter(Boolean);

    const isMatch = fileExt && filterExtArray.includes(fileExt);

    // 3. 未命中接管扩展名（如图片 .jpg/.png/.webp、文档 .pdf 等），或无法连接 Native Host 获取配置时，直接放行给浏览器下载
    if (!isMatch) {
      console.log(`[下载任务拦截] 文件名 "${filename}" 的扩展名 (.${fileExt}) 未在拦截列表中，放行交由浏览器原生下载。`);
      suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    // 4. 命中拦截扩展名，推送到比特彗星
    console.log(`[下载任务拦截] 文件名 "${filename}" 匹配接管扩展名 (.${fileExt})，准备推送到比特彗星...`);
    sendToBitComet(item).then((success) => {
      if (success) {
        // 推送成功：自动取消并清理浏览器端的原生下载任务
        try {
          chrome.downloads.cancel(item.id, () => {
            chrome.downloads.erase({ id: item.id });
            console.log(`[下载任务传递信息] 已自动接管并清除内置下载 (ID: ${item.id})`);
          });
        } catch (err) {
          console.error("[下载任务传递信息] 取消下载任务失败:", err);
        }
      } else {
        // 推送失败：降级回退交由浏览器原生下载
        console.warn("[下载任务传递信息] 调起比特彗星失败，回退为浏览器原生下载");
        suggest({ filename: item.filename, conflictAction: 'uniquify' });
      }
    });
  });

  return true; // 保持异步回调机制
});

/**
 * 设置插件开关状态，同步修改存储与图标 UI
 */
function SetPluginEnabled(bEnabled) {
	chrome.storage.local.set({ bPluginEnabled: bEnabled });
	UpdateBrowserActionIcon(bEnabled);
}

/**
 * 右键菜单点击处理逻辑：强制转化为 Chrome 原生下载任务，交由 onDeterminingFilename 事件捕获与解析文件名
 */
function onStartupDownload(info, tab) {
	let targetUrl = info.linkUrl || info.srcUrl || info.pageUrl;
	let refererUrl = info.pageUrl || "";

	if (info.pageUrl === "chrome://downloads/") {
		chrome.downloads.search(
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
 * 通过调用 chrome.downloads.download 强制唤醒下载流，利用 Chrome 完成 HTTP 预检和文件名提取
 */
function ForceTriggerChromeDownload(link, refererUrl) {
	console.log("[下载任务传递信息] 右键强制重定向为原生下载流程:", link);
	chrome.downloads.download({
		url: link,
		saveAs: false
	}, (downloadId) => {
		if (chrome.runtime.lastError) {
			console.error("[下载任务传递信息] 触发原生下载失败:", chrome.runtime.lastError.message);
		} else {
			console.log(`[下载任务传递信息] 成功触发临时原生下载任务 (ID: ${downloadId})，等待拦截管线捕获文件名...`);
		}
	});
}

/**
 * 获取客户端配置（例如比特彗星内部设定的扩展名列表）
 */
function InvokeGetHostConfig() {
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST,
	  { action: "GetConfig" },
	  async function(response) {
		if (chrome.runtime.lastError) {
			console.error("[BitComet Native 通信错误] 无法与客户端建立连接: " + chrome.runtime.lastError.message);
		} else if (response) {
			console.log("Received Config: " + JSON.stringify(response));
			let settingValues = await chrome.storage.local.get(["sExtFilterList"]);
			if (typeof settingValues == 'undefined' || settingValues.sExtFilterList != response.ext_list) {
				chrome.storage.local.set({ sExtFilterList: response.ext_list });
			}
		}
	});
}

/**
 * 调起比特彗星客户端主界面
 */
function InvokeLaunchProgram() {
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST,
	  { action: "Launch_Program" },
	  function(response) {
		if (chrome.runtime.lastError) {
			console.error("LaunchProgram Error: " + chrome.runtime.lastError.message);
		} else if (response && response.status !== "ok") {
			console.error("LaunchProgram Failed: " + JSON.stringify(response));
		}
	  });
}

/**
 * 初始化右键菜单：支持链接、图片、音频和视频等多种右键场景
 */
function CreateContextMenu() {
	chrome.contextMenus.removeAll(function() {
		chrome.contextMenus.create({
			id: contextMenuId,
			type: "normal",
			title: chrome.i18n.getMessage("context_menu_title"),
			contexts: ["link", "image", "audio", "video"],
			enabled: true
		});
		chrome.contextMenus.onClicked.addListener((info, tab) => {
			if (info.menuItemId == contextMenuId) {
				onStartupDownload(info, tab);
			}
		});
	});
}

function UpdateContextMenuTitle(title) {
	chrome.contextMenus.update(contextMenuId, { title: title });
}

/**
 * 根据插件开/关状态动态切换工具栏上的显示图标
 */
async function UpdateBrowserActionIcon(bPluginEnabled) {
	if (bPluginEnabled == null) {
		let settingValues = await chrome.storage.local.get(["bPluginEnabled"]);
		bPluginEnabled = Boolean(settingValues.bPluginEnabled);
	}

	var iconPath = bPluginEnabled ? "images/icon19_normal.png" : "images/icon19_disabled.png";
	chrome.action.setIcon({ path: iconPath });
}

/**
 * 注册与外部 UI（Popup 弹窗页面）通信的消息监听器
 */
function RegisterEventListener() {
	chrome.windows.onFocusChanged.addListener(function(windowId) {
		if (chrome.windows.WINDOW_ID_NONE != windowId)
			InvokeGetHostConfig();
	});

	chrome.runtime.onMessage.addListener(function(message, sender, response) {
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
		response(true);
	});
}

/**
 * 仅在插件首次安装/更新/加载时进行一次 Native 通信预检与默认状态初始化
 */
chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.get(["bPluginEnabled"], (result) => {
		if (typeof result.bPluginEnabled === 'undefined') {
			chrome.storage.local.set({ bPluginEnabled: false });
		}
	});
	InvokeGetHostConfig();
});

function Init() {
	CreateContextMenu();
	UpdateBrowserActionIcon();
	RegisterEventListener();
}

Init();