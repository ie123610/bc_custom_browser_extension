const BITCOMET_NATIVE_HOST = 'org.custom.bitcomet_bridge';
const contextMenuId = "BitCometContextMenu";

// 全局缓存配置状态
const storageCache = {
	bPluginEnabled: true,
	sExtFilterList: ""
};

/**
 * 获取目标 URL Cookie 并透传给比特彗星 Native 宿主程序
 */
function sendToBitComet(downloadItem) {
  return new Promise((resolve) => {
    const originalUrl = downloadItem.url || '';
    const finalUrl = downloadItem.finalUrl || downloadItem.url; // 优先取重定向后的终点地址
    const referrerUrl = downloadItem.referrer || '';

    // 调试输出：打印当前下载任务的原始 URL 与最终重定向 URL
    console.group("[下载任务传递信息]");
    console.log("-> 原始请求 URL (originalUrl):", originalUrl);
    console.log("-> 重定向终点 URL (finalUrl):", finalUrl);
    console.log("-> 来源页面 (referrerUrl):", referrerUrl);

    // 优先尝试获取原始 URL (如 github.com) 的 Cookie，若无则尝试获取最终 URL 的 Cookie
    chrome.cookies.getAll({ url: originalUrl }, (origCookies) => {
      chrome.cookies.getAll({ url: finalUrl }, (finalCookies) => {
        // 合并并去重两者的 Cookie 结果
        const cookieMap = new Map();
        if (origCookies) origCookies.forEach(c => cookieMap.set(c.name, c.value));
        if (finalCookies) finalCookies.forEach(c => cookieMap.set(c.name, c.value));

        const cookieList = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`);
        const cookieString = cookieList.join('; ');

        console.log(`-> 查找到的 Cookie 数量: ${cookieMap.size} 个`);
        console.log("-> 最终生成的 Cookie 字符串:", cookieString || "(空)");

        const payload = {
          action: "Download",
          link: finalUrl,
          cookie: cookieString,
          referurl: referrerUrl,
          user_agent: navigator.userAgent
        };

        console.log("-> 发送给 Native Host 的完整 Payload 数据:", JSON.stringify(payload, null, 2));
        console.groupEnd();

        chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST, payload, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[下载任务传递信息] 调用 Native Host 失败:", chrome.runtime.lastError.message);
            resolve(false);
          } else {
            console.log("[下载任务传递信息] 比特彗星响应成功:", response);
            resolve(true);
          }
        });
      });
    });
  });
}

/**
 * 核心拦截：接管下载文件名确定事件，取代原版的弹窗告警流程
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 读取插件全局使能开关，若插件被禁用，则直接恢复原生下载
  chrome.storage.local.get(["bPluginEnabled"], (result) => {
    const isEnabled = result.bPluginEnabled !== false; // 默认开启

    if (!isEnabled) {
      suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    // 插件开启状态下，无条件静默推送到比特彗星
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
        // 推送失败（例如比特彗星未启动）：回退交由浏览器原生下载
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
 * 右键菜单点击处理逻辑
 */
function onStartupDownload(info, tab) {
	if (info.pageUrl == "chrome://downloads/") {
		chrome.downloads.search(
			{ url: info.linkUrl, orderBy: ['-startTime'], limit: 1 },
			function(data) {
				var refererUrl = "";
				if (data && data.length > 0) {
					refererUrl = data[0].referrer;
				}
				PrepareDownload(info.linkUrl, refererUrl);
			});
	} else {
		PrepareDownload(info.linkUrl, info.pageUrl);
	}
}

/**
 * 手动右键下载时提取 Cookie 并调起比特彗星
 */
function PrepareDownload(link, refererUrl) {
	console.log("[下载任务传递信息] 右键触发下载，开始读取 Cookie:", link);
	chrome.cookies.getAll({ url: link }, function(cookies) {
		var cookie = "";
		for (var i in cookies) {
			cookie = cookie.concat(cookies[i].name, "=", cookies[i].value, "; ");
		}
		console.log("[下载任务传递信息] 右键提取的 Cookie 字符串:", cookie || "(空)");
		InvokeDownload(link, cookie, refererUrl);
	});
}

/**
 * 直接向 Native Messenger 发送二进制任务指令
 */
function InvokeDownload(link, cookie, referurl) {
	const payload = { 
		action: "Download", 
		link: link, 
		cookie: cookie, 
		referurl: referurl,
		user_agent: navigator.userAgent
	};
	console.log("[下载任务传递信息] InvokeDownload 发送 Payload:", payload);
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST, payload,
	  function(response) {
		if (chrome.runtime.lastError) {
			console.error("InvokeDownload Error: " + chrome.runtime.lastError.message);
		} else {
			console.log("InvokeDownload Received: " + JSON.stringify(response));
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
		}
	  });
}

/**
 * 初始化右键菜单
 */
function CreateContextMenu() {
	chrome.contextMenus.removeAll(function() {
		chrome.contextMenus.create({
			id: contextMenuId,
			type: "normal",
			title: chrome.i18n.getMessage("context_menu_title"),
			contexts: ["link"],
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
		bPluginEnabled = settingValues.bPluginEnabled !== false;
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
			InvokeDownload(message.link, message.cookie, message.referurl);
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
 * 仅在插件首次安装/更新/加载时进行一次 Native 通信预检
 */
chrome.runtime.onInstalled.addListener(() => {
	InvokeGetHostConfig();
});

function Init() {
	CreateContextMenu();
	UpdateBrowserActionIcon();
	RegisterEventListener();
}

Init();