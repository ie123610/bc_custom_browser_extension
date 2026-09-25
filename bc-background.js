const BITCOMET_NATIVE_HOST = 'com.bitcomet.chrome_extension';
const contextMenuId = "BitCometContextMenu";

// 全局缓存配置状态[cite: 13, 17]
const storageCache = {
	bPluginEnabled: true,
	sExtFilterList: ""
};

/**
 * 获取目标 URL Cookie 并透传给比特彗星 Native 宿主程序[cite: 13, 15, 17]
 */
function sendToBitComet(downloadItem) {
  return new Promise((resolve) => {
    const targetUrl = downloadItem.finalUrl || downloadItem.url; // 优先取重定向后的终点地址[cite: 15, 17]
    const referrerUrl = downloadItem.referrer || '';

    // 获取完整 Cookie 以支持带鉴权/防盗链的下载[cite: 13, 15, 17]
    chrome.cookies.getAll({ url: targetUrl }, (cookies) => {
      let cookieString = '';
      if (cookies && cookies.length > 0) {
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }

      const payload = {
        action: "Download",
        link: targetUrl,
        cookie: cookieString,
        referurl: referrerUrl
      };

      console.log("[BitComet Ext] 发送任务至比特彗星:", payload);

      chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST, payload, (response) => {
        if (chrome.runtime.lastError) {
          console.error("[BitComet Ext] 调用 Native Host 失败:", chrome.runtime.lastError.message);
          resolve(false);
        } else {
          console.log("[BitComet Ext] 比特彗星响应成功:", response);
          resolve(true);
        }
      });
    });
  });
}

/**
 * 核心拦截：接管下载文件名确定事件，取代原版的弹窗告警流程[cite: 13, 15, 17]
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 读取插件全局使能开关，若插件被禁用，则直接恢复原生下载[cite: 13, 15, 17]
  chrome.storage.local.get(["bPluginEnabled"], (result) => {
    const isEnabled = result.bPluginEnabled !== false; // 默认开启

    if (!isEnabled) {
      suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return;
    }

    // 插件开启状态下，无条件静默推送到比特彗星[cite: 15, 17]
    sendToBitComet(item).then((success) => {
      if (success) {
        // 推送成功：自动取消并清理浏览器端的原生下载任务[cite: 13, 15, 17]
        try {
          chrome.downloads.cancel(item.id, () => {
            chrome.downloads.erase({ id: item.id });
            console.log(`[BitComet Ext] 已自动接管并清除内置下载 (ID: ${item.id})`);
          });
        } catch (err) {
          console.error("[BitComet Ext] 取消下载任务失败:", err);
        }
      } else {
        // 推送失败（例如比特彗星未启动）：回退交由浏览器原生下载[cite: 15, 17]
        suggest({ filename: item.filename, conflictAction: 'uniquify' });
      }
    });
  });

  return true; // 保持异步回调机制[cite: 15, 17]
});

/**
 * 设置插件开关状态，同步修改存储与图标 UI[cite: 13, 17]
 */
function SetPluginEnabled(bEnabled) {
	chrome.storage.local.set({ bPluginEnabled: bEnabled });
	UpdateBrowserActionIcon(bEnabled);
}

/**
 * 右键菜单点击处理逻辑[cite: 13, 17]
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
 * 手动右键下载时提取 Cookie 并调起比特彗星[cite: 13, 17]
 */
function PrepareDownload(link, refererUrl) {
	chrome.cookies.getAll({ url: link }, function(cookies) {
		var cookie = "";
		for (var i in cookies) {
			cookie = cookie.concat(cookies[i].name, "=", cookies[i].value, "; ");
		}
		InvokeDownload(link, cookie, refererUrl);
	});
}

/**
 * 直接向 Native Messenger 发送二进制任务指令[cite: 13, 17]
 */
function InvokeDownload(link, cookie, referurl) {
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST,
	  { action: "Download", link: link, cookie: cookie, referurl: referurl },
	  function(response) {
		if (chrome.runtime.lastError) {
			console.log("InvokeDownload Error: " + chrome.runtime.lastError.message);
		} else {
			console.log("InvokeDownload Received: " + JSON.stringify(response));
		}
	  });
}

/**
 * 获取客户端配置（例如比特彗星内部设定的扩展名列表）[cite: 13, 17]
 */
function InvokeGetHostConfig() {
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST,
	  { action: "GetConfig" },
	  async function(response) {
		if (chrome.runtime.lastError) {
			console.log("InvokeGetHostConfig Error: " + chrome.runtime.lastError.message);
		} else if (response) {
			let settingValues = await chrome.storage.local.get(["sExtFilterList"]);
			if (typeof settingValues == 'undefined' || settingValues.sExtFilterList != response.ext_list) {
				chrome.storage.local.set({ sExtFilterList: response.ext_list });
			}
		}
	});
}

/**
 * 调起比特彗星客户端主界面[cite: 13, 17]
 */
function InvokeLaunchProgram() {
	chrome.runtime.sendNativeMessage(BITCOMET_NATIVE_HOST,
	  { action: "Launch_Program" },
	  function(response) {
		if (chrome.runtime.lastError) {
			console.log("LaunchProgram Error: " + chrome.runtime.lastError.message);
		}
	  });
}

/**
 * 初始化右键菜单[cite: 13, 17]
 */
function CreateContextMenu() {
	chrome.contextMenus.removeAll(function() {
		chrome.contextMenus.create({ id: contextMenuId, type: "normal", title: "Download with BitComet", contexts: ["link"], enabled: true });
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
 * 根据插件开/关状态动态切换工具栏上的显示图标[cite: 13, 17]
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
 * 注册与外部 UI（Popup 弹窗页面）通信的消息监听器[cite: 13, 17]
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

function Init() {
	InvokeGetHostConfig();
	CreateContextMenu();
	UpdateBrowserActionIcon();
	RegisterEventListener();
}

Init();