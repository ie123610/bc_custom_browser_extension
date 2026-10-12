// Firefox 插件

const BITCOMET_NATIVE_HOST = 'org.custom.bitcomet_bridge';
const contextMenuId = "BitCometContextMenu";

// 跨浏览器 API 命名空间兼容
const extAPI = typeof browser !== 'undefined' ? browser : chrome;

// 记录已处理或正在处理的下载 ID，防止 onCreated / onChanged 重复触发
const processedDownloadIds = new Set();

// Native Host 可用性预检标志
// null  = 尚未探测，按"可能可用"处理
// true  = 最近一次通信成功
// false = 最近一次通信失败，拦截前会跳过，保留浏览器原生下载
let nativeHostAvailable = null;

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
 * 移植自 Xdown 的 CookieManager
 * 保留浏览器返回的全部 Cookie，不按名称去重
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
    // 空数组保护：立即回调空字符串，避免 Promise 永远 pending
    if (!urls || urls.length === 0) {
        callback(['']);
        return;
    }

    var remained = urls.length;
    var result = [];

    for (var i = 0; i < urls.length; ++i) {
        extAPI.cookies.getAll(
            { 'url': urls[i] },
            function (resultIndex, cookies) {
                var cookiesString = "";
                if (cookies) {
                    // 直接保留浏览器返回的全部 Cookie，不按名称去重
                    cookiesString = cookies.map(function (cookie) {
                        return cookie.name + "=" + cookie.value;
                    }).join('; ');
                }
                result[resultIndex] = cookiesString;
                if (!--remained) {
                    callback(result);
                }
            }.bind(this, i));
    }
}

/**
 * 原生消息传递（Native Messaging）封装
 * 兼容 Firefox 的 Promise 风格与 Chrome 的回调风格
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
    const finalUrl = downloadItem.finalUrl || downloadItem.url; // 优先取重定向后的终点地址
    const referrerUrl = downloadItem.referrer || '';

    // Firefox 的 downloadItem.filename 通常包含完整保存路径，需要清理为纯文件名
    const rawFilename = downloadItem.filename || '';
    const cleanFilename = rawFilename.replace(/^.*[\\/]/, '');

    // 只取最终下载 URL 的 Cookie，避免跨域合并导致鉴权错误
    const targetUrls = [finalUrl || originalUrl].filter(Boolean);

    // 调试输出：打印当前下载任务的原始 URL 与最终重定向 URL
    console.group("[下载任务传递信息]");
    console.log("-> 原始请求 URL (originalUrl):", originalUrl);
    console.log("-> 重定向终点 URL (finalUrl):", finalUrl);
    console.log("-> 来源页面 (referrerUrl):", referrerUrl);
    console.log("-> 清理后的文件名 (cleanFilename):", cleanFilename);
    console.log("-> Cookie 查询 Target URL:", targetUrls[0] || "(无)");

    // 调用 CookieManager 获取最终下载 URL 的 Cookie
    var cManager = new CookieManager();
    cManager.getCookiesForUrls(targetUrls, function (results) {
        const cookieString = (results && results[0]) || '';

        console.log("-> 最终生成的 Cookie 字符串:", cookieString || "(空)");

        const payload = {
          action: "Download",
          link: finalUrl,
          name: cleanFilename, // 传入清理后的纯文件名
          cookie: cookieString,
          referurl: referrerUrl,
          user_agent: navigator.userAgent
        };

        console.log("-> 发送给 Native Host 的完整 Payload 数据:", JSON.stringify(payload, null, 2));
        console.groupEnd();

        sendNativeMessageCompat(BITCOMET_NATIVE_HOST, payload).then((res) => {
          if (res.error) {
            console.error("[下载任务传递信息] 调用 Native Host 失败:", res.error.message || res.error);
            // 更新预检标志，后续拦截将跳过
            nativeHostAvailable = false;
            resolve(false);
            return;
          }

          var response = res.response;
          if (response && response.status === "ok") {
            console.log("[下载任务传递信息] 比特彗星响应成功:", response);
            // 通信成功，更新预检标志
            nativeHostAvailable = true;
            resolve(true);
          } else {
            console.error("[下载任务传递信息] 比特彗星响应错误，详细原因:", response ? response.message : "未知响应格式");
            // 管道通了但业务失败，不算 Host 不可用
            nativeHostAvailable = true;
            resolve(false);
          }
        });
    });
  });
}

/**
 * 读取配置并判断给定文本（文件名或 URL）的扩展名是否在拦截白名单中
 */
function checkExtensionMatch(text, filterString) {
  if (!text) return false;

  const cleanStr = text.split('?')[0].split('#')[0].replace(/^.*[\\/]/, '');
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
 * 采用"先取消、后发送"顺序，把浏览器下载 UI 的可见窗口压到最小
 * 发送前先检查 nativeHostAvailable 预检标志，明确不可用时直接放行浏览器原生下载
 */
function executeFirefoxIntercept(item) {
  if (processedDownloadIds.has(item.id)) return;
  processedDownloadIds.add(item.id);

  // 预检：Native Host 已知不可用时，放弃拦截，保留浏览器原生下载
  if (nativeHostAvailable === false) {
    console.warn("[下载任务传递信息] Native Host 预检标记为不可用，跳过拦截，保留浏览器原生下载");
    processedDownloadIds.delete(item.id);
    return;
  }

  // 先取消浏览器下载，压缩 UI 闪烁窗口
  try {
    extAPI.downloads.cancel(item.id, () => {
      extAPI.downloads.erase({ id: item.id });
      console.log(`[下载任务传递信息] 已取消内置下载 (ID: ${item.id})，开始发送到比特彗星...`);

      // 取消成功后再异步发送给比特彗星
      sendToBitComet(item).then((success) => {
        if (success) {
          console.log("[下载任务传递信息] 比特彗星接管成功");
        } else {
          // 此时浏览器下载已被取消，无法恢复；仅记录日志，更新预检标志
          console.warn("[下载任务传递信息] 调起比特彗星失败，但浏览器下载已取消，用户需重新触发下载");
          processedDownloadIds.delete(item.id);
        }
      });
    });
  } catch (err) {
    console.error("[下载任务传递信息] 取消下载任务失败:", err);
    // 取消失败，说明下载可能仍在继续，回退为浏览器原生下载
    processedDownloadIds.delete(item.id);
  }
}

/**
 * 第一层 onCreated 快速拦截管线
 * 优先从文件名判断扩展名，文件名不完整时回退到 URL
 */
function handleFirefoxOnCreated(item) {
  if (processedDownloadIds.has(item.id)) return;

  const targetUrl = item.finalUrl || item.url || '';
  if (shouldSkipIntercept(targetUrl)) {
    console.log(`[下载任务拦截] 检测到特殊协议 URL "${targetUrl}"，直接放行交由浏览器处理。`);
    return;
  }

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = Boolean(result.bPluginEnabled);
    if (!isEnabled) return;

    const filterString = result.sExtFilterList || "";

    // 第一优先：文件名
    const filename = item.filename || "";
    let isMatch = checkExtensionMatch(filename, filterString);

    // 第二优先：URL
    if (!isMatch) {
      isMatch = checkExtensionMatch(item.url, filterString);
    }

    if (!isMatch) {
      console.log(`[下载任务拦截] onCreated 未命中扩展名白名单，等待 onChanged 进一步判断。文件名="${filename}"`);
      return;
    }

    console.log(`[下载任务拦截] onCreated 命中扩展名白名单，准备推送到比特彗星...`);
    executeFirefoxIntercept(item);
  });
}

/**
 * 第二层 onChanged 动态拦截管线
 * 针对重定向及动态生成文件名的场景
 */
function handleFirefoxOnChanged(delta) {
  if (processedDownloadIds.has(delta.id)) return;
  if (!delta.filename || !delta.filename.current) return;

  const fullPath = delta.filename.current || "";
  const cleanFilename = fullPath.replace(/^.*[\\/]/, '');

  extAPI.storage.local.get(["bPluginEnabled", "sExtFilterList"], (result) => {
    const isEnabled = Boolean(result.bPluginEnabled);
    if (!isEnabled) return;

    const filterString = result.sExtFilterList || "";
    if (!checkExtensionMatch(cleanFilename, filterString)) return;

    console.log(`[下载任务拦截] onChanged 命中扩展名白名单 (文件名="${cleanFilename}")，准备推送到比特彗星...`);

    extAPI.downloads.search({ id: delta.id }, (items) => {
      if (items && items.length > 0) {
        executeFirefoxIntercept(items[0]);
      }
    });
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
 * 右键菜单点击处理逻辑：强制转化为浏览器原生下载任务，交由拦截管线解析文件名
 */
function onStartupDownload(info, tab) {
	let targetUrl = info.linkUrl || info.srcUrl || info.pageUrl;
	let refererUrl = info.pageUrl || "";

	if (info.pageUrl === "about:downloads") {
		extAPI.downloads.search(
			{ url: targetUrl, orderBy: ['-startTime'], limit: 1 },
			function(data) {
				if (data && data.length > 0) {
					refererUrl = data[0].referrer || refererUrl;
				}
				ForceTriggerDownload(targetUrl, refererUrl);
			}
		);
	} else {
		ForceTriggerDownload(targetUrl, refererUrl);
	}
}

/**
 * 通过调用 downloads.download 强制唤醒下载流，利用浏览器完成 HTTP 预检和文件名提取
 */
function ForceTriggerDownload(link, refererUrl) {
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
 * 同时刷新 nativeHostAvailable 预检标志
 */
function InvokeGetHostConfig() {
	sendNativeMessageCompat(BITCOMET_NATIVE_HOST, { action: "GetConfig" }).then((res) => {
		if (res.error) {
			console.error("[BitComet Native 通信错误] 无法与客户端建立连接: " + (res.error.message || res.error));
			nativeHostAvailable = false;
		} else if (res.response) {
			var response = res.response;
			console.log("Received Config: " + JSON.stringify(response));
			nativeHostAvailable = true;
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
			nativeHostAvailable = false;
		} else if (res.response && res.response.status !== "ok") {
			console.error("LaunchProgram Failed: " + JSON.stringify(res.response));
		} else {
			nativeHostAvailable = true;
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
		bPluginEnabled = Boolean(settingValues && settingValues.bPluginEnabled);
	}

	var iconPath = bPluginEnabled ? "images/icon19_normal.png" : "images/icon19_disabled.png";
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
		return true;
	});
}

/**
 * 仅在插件首次安装/更新/加载时进行一次 Native 通信预检与默认状态初始化
 */
if (extAPI.runtime.onInstalled) {
	extAPI.runtime.onInstalled.addListener(() => {
		extAPI.storage.local.get(["bPluginEnabled"], (result) => {
			if (typeof result.bPluginEnabled === 'undefined') {
				extAPI.storage.local.set({ bPluginEnabled: false });
			}
		});
		InvokeGetHostConfig();
	});
}

function Init() {
	CreateContextMenu();
	UpdateBrowserActionIcon();
	RegisterEventListener();
	// 启动时立即做一次预检，让 nativeHostAvailable 尽早有值
	InvokeGetHostConfig();
}

Init();