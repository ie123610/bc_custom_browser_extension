// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var bPluginEnabled;

function OnClickEnableDownloadCapture(e)
{
	bPluginEnabled = !bPluginEnabled;
	chrome.runtime.sendMessage(null, {
		name: 'setPluginEnable',
		value: bPluginEnabled
	}, (response) => {
		window.close();
	});
}

function OnClickLaunchProgram(e)
{
	chrome.runtime.sendMessage(null, {
		name: 'launchProgram',
	}, (response) => {
		window.close();
	});
}

async function Init()
{
	// load local settings
	let settingValues = await chrome.storage.local.get(["bPluginEnabled"]);
	bPluginEnabled = settingValues.bPluginEnabled;

	document.getElementById('EnableDownloadCapture').innerText = chrome.i18n.getMessage("popup_enable_bitcomet");
	document.getElementById('LaunchProgram').innerText = chrome.i18n.getMessage("popup_launch_program");

	if (bPluginEnabled)
	{
		document.getElementById('EnableDownloadCapture').className = 'item item-selected';
	}
	else
	{
		document.getElementById('EnableDownloadCapture').className= 'item item-unselect';
	}
}

document.addEventListener('DOMContentLoaded',
	function ()
	{
		document.getElementById('EnableDownloadCapture').addEventListener('click', OnClickEnableDownloadCapture);
		document.getElementById('LaunchProgram').addEventListener('click', OnClickLaunchProgram);

		Init();
	}
);
