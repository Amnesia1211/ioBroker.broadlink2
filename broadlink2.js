/**
 *      iobroker bmw Adapter
 *      (c) 2016- <frankjoke@hotmail.com>
 *      MIT License
 */
// jshint node:true, esversion:6, strict:global, undef:true, unused:true
"use strict";
const utils = require('./lib/utils'),
	adapter = utils.adapter('broadlink2'),
	broadlink = require('./lib/broadlink'),
	dns = require('dns'),
	assert = require('assert'),
	A = require('./myAdapter');

const scanList = {},
	tempName = '.Temperature',
	humName = '.Humidity',
	lightName = '.Light',
	lightRAWName = '.LightRAW',
	airQualityName = '.AirQuality',
	airQualityRAWName = '.AirQualityRAW',
	noiseName = '.Noise',
	noiseRAWName = '.NoiseRAW',
	learnName = '.Learn',
	sendName = '.SendCode',
	sceneName = 'SendScene',
	scenesName = 'Scenes',
	learnedName = '.L.',
	scanName = 'NewDeviceScan',
	codeName = "CODE_",
	reCODE = /^CODE_|^/,
	reIsCODE = /^CODE_[a-f0-9]{16}/,
	defaultName = '>>> Rename learned @ ';

var currentDevice;

A.init(adapter, main); // associate adapter and main with MyAdapter

A.objChange = function (obj) { //	This is needed for name changes
	if (typeof obj === 'string' && obj.indexOf(learnedName) > 0)
		return A.getObject(obj)
			.then(oobj => {
				const nst = oobj.common,
					ncn = nst.name,
					dev = obj.split('.'),
					fnn = dev.slice(2, -1).concat(ncn).join('.');
				if (ncn == dev[4] || ncn.startsWith(defaultName)) // no need to rename!
					return null;
				if (!A.states[fnn] ? (ncn.match(/[\ \.\,\;]/g) || !oobj.native.code ?
						A.W(`Cannot rename to ${oobj.common.name} because it includes charaters like " .,;" or does not have a learned code: ${obj}`, true) :
						false) :
					A.W(`Cannot rename to ${ncn} because the name is already used: ${obj}`, true)) {
					oobj.common.name = dev[4];
					return A.setObject(obj, oobj)
						.catch(e => A.W(`rename back err ${e} on ${A.O(oobj)}!`));
				}
				nst.id = (dev[2] + learnedName + ncn);
				nst.native = oobj.native;
				//				nst.val = codeName + oobj.native.code;
				if (oobj.common.name != dev[4])
					return A.makeState(nst, false, true)
						.then(() => A.removeState(A.I(`rename ${obj} to ${fnn}!`, obj)).catch(() => true));
			})
			.catch(err => A.W(`objChange error: ${obj}} ${err}`));
};

function sendCode(device, value) {
	let buffer = new Buffer(value.replace(reCODE, ''), 'hex'); //var buffer = new Buffer(value.substr(5), 'hex'); // substr(5) removes CODE_ from string

	device.sendData(buffer);
	return Promise.resolve(device.name + ' sent ' + value);
	//	return Promise.resolve(A.D('sendData to ' + device.name + ', Code: ' + value));
}

A.stateChange = function (id, state) {

	function startLearning(name) {
		const device = scanList[name];
		assert(!!device, `wrong name "${name}" in startLearning`);
		A.I('Start learning for device: ' + name);
		var learned = 35;
		device.emitter.once("rawData", data => { // use current.emitter.once, not the copy current.on. Otherwise this event will be called as often you call current.on()
			const hex = data.toString('hex');
			learned = 0;
			A.getObjectList({
					startkey: A.ain + name + learnedName,
					endkey: A.ain + name + learnedName + '\u9999'
				})
				.catch(() => ({
					rows: []
				}))
				.then(res => {
					for (let i of res.rows)
						if (i.doc.native.code == hex) // ? i.doc.common.name
							return Promise.reject(i.doc.common.name);
					return true;
				})
				.then(() => A.makeState({
						id: name + learnedName + codeName + hex,
						name: `${defaultName}${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}`,
						write: true,
						role: 'button',
						type: typeof true,
						native: {
							code: hex
						}
					}, false, A.I(`Learned new Code ${device.name} (hex): ${hex}`, true)),
					nam => A.I(`Code alreadly learned from: ${device.name} with ${nam}`))
				.catch(err => A.W(`learning makeState error: ${device.name}} ${err}`));
		});
		device.enterLearning();
		return A.retry(learned, () => --learned <= 0 ? Promise.resolve() :
				A.wait(A.D(`Learning for ${device.name} wait ${learned} `, 1000))
				.then(() => Promise.reject(device.checkData())))
			.then(() => A.I(`Stop learning for ${name}!`), () => A.I(`Stop learning for ${name}!`));
	}

	//	A.D(`stateChange of "${id}": ${A.O(state)}`); 
	if (!state.ack) {
		if (id.startsWith(A.ain))
			id = id.slice(A.ain.length);
		let idx = id.split('.'),
			id0 = idx[0];
		if (id0 === scanName && idx.slice(-1)[0] === scanName) return Promise.resolve(currentDevice ? A.D(`Restart scan to discover devices!`, currentDevice.discover()) : A.W(`No current driver to start discover!`));
		if (id0 === sceneName && idx.slice(-1)[0] === sceneName) {
			const scene = state.val;
			state.val = true;
			return sendScene(scene, state);
		}
		//		A.D(`Somebody (${state.from}) id0 ${id0} changed ${id} of "${id0}" to ${A.O(state)}`);
		if (id0 === scenesName)
			return A.getObject(id)
				.then((obj) =>
					obj && obj.native && obj.native.scene ?
					sendScene(obj.native.scene, state) :
					Promise.reject(A.D(`Invalid command "${id}" in scenes`)));
		let device = scanList[id0];
		if (!device) return Promise.reject(A.W(`stateChange error no device found: ${id} ${A.O(state)}`));
		switch (id0.split(':')[0]) {
			case 'SP':
				device.set_power(A.parseLogic(state.val));
				A.I(`Change ${id} to ${state.val}`);
				return Promise.resolve(device.oval = state.val);
			case 'RM':
				if (id.endsWith(sendName))
					return state.val.startsWith(codeName) ? sendCode(device, state.val) :
						Promise.reject(A.W(`Code to send to ${id0} needs to start with ${codeName}`))
				if (id.endsWith(learnName))
					return startLearning(id0);
				return reIsCODE.test(state.val) && sendCode(device, state.val) ||
					A.getObject(id)
					.then((obj) =>
						obj && obj.native && obj.native.code ?
						sendCode(device, obj.native.code) :
						Promise.reject(A.W(`cannot get code to send for: ${id}=${id0} ${A.O(state)}`)));
			default:
				return Promise.reject(A.W(`stateChange error invalid id type: ${id}=${id0} ${A.O(state)}`));
		}
	}
};

function sendScene(scene, st) {
	const s = A.T(scene, []) ? A.trim(scene) : A.T(scene, '') ? A.trim(scene.split(',')) : `error in scene: neither a string nor an Array!: ${A.O(scene)}`;
	const sn = s.map(ss => A.trim(ss) === parseInt(ss).toString() ? parseInt(ss) : A.trim(ss));
	return A.seriesOf(sn, i => {
		if (typeof i === 'number')
			return A.wait(i);
		if (i.split('=').length === 2) {
			let s = A.trim(i.split('='));
			i = s[0];
			st.val = s[1]
		} else st.val = true;
		if (i.startsWith(A.ain))
			i = i.slice(A.ain.length);

		const j = A.trim(i.split('.')),
			id = j[0],
			code = j[1];
		if (id.startsWith('RM:') && scanList[id] && code.startsWith(codeName))
			return sendCode(scanList[id], code);

		if (id.startsWith('RM:') || id.startsWith('SP:') || i.startsWith(scenesName + '.'))
			return A.stateChange(i, st);

		return A.getState(i).then(() =>
			A.setForeignState(i, st, false),
			err =>
			A.W(`id ${i[0]} not found in scene ${scene}`))
	}, 100);
}

A.messages = (msg) => {
	if (A.T(msg.message) !== 'string')
		return A.W(`Wrong message received: ${A.O(msg)}`)
	const st = {
			val: true,
			ack: false,
			from: msg.from
		};
	var	id = msg.message.startsWith(A.ain) ? msg.message.trim() : A.ain + (msg.message.trim());

	//	A.D(`Execute Message ${A.O(id)}`);

	switch (msg.command) {
		case 'switch_off':
			st.val = false;
		case 'switch_on':
		case 'send':
			return A.getObject(id)
				.then(obj => obj.common.role === 'button' || (obj.common.role === 'switch' && msg.command.startsWith('switch')) ?
					A.stateChange(id, st) :
					Promise.reject(A.W(`Wrong id or message ${A.O(msg)} id = ${A.O(obj)}`)),
					err => Promise.reject(err))
				.then(() => A.D(`got message sent: ${msg.message}`));
		case 'send_scene':
			return sendScene(msg.message, st);
		case 'send_code':
			if (msg.message.startsWith(A.ain))
				msg.message = msg.message.slice(A.ain.length)
			let ids = msg.message.split('.'),
				code = ids[1];
			id = ids[0];
			if (!id.startsWith('RM:') || !scanList[id] || !code.startsWith(codeName))
				return Promise.reject(A.D(`Invalid message "${msg.message}" for "send" to ${id}${sendName}`));
			return Promise.resolve(A.D(`Executed on ${id} the message "${msg.message}"`), sendCode(scanList[id], code));
		case 'get':
			return A.getState(id)
		case 'switch':
			let idx = A.split(msg.message, '=');
			if (idx.length != 2 && !idx.startsWith('SP:'))
				return Promise.reject(A.D(`Invalid message to "switch" ${msg.message}" to ${idx}`));
			st.val = A.parseLogic(idx[1]);
			return A.stateChange(idx[0], st);
		default:
			return Promise.reject(A.D(`Invalid command "${msg.command}" received with message ${A.O(msg)}`));
	}
};


function main() {

	function doPoll() {
		A.seriesOf(A.obToArray(scanList), device =>
			Promise.resolve(device.checkTemperature && device.checkTemperature(),
				device.check_sensors && device.check_sensors(),
				device.check_power && device.check_power()), 50);
	}

	A.I('Discover UDP devices for 10sec on ' + A.ains);
	currentDevice = new broadlink();

	if ((A.debug = adapter.config.ip.startsWith('debug!')))
		adapter.config.ip = adapter.config.ip.slice(A.D(`Debug mode on!`, 6));

	adapter.config.ip = adapter.config.ip.trim().toLowerCase();

	currentDevice.on("deviceReady", function (device) {
		const typ = device.getType().slice(0, 2);
		device.typ = typ;
		A.c2p(dns.reverse)(device.host.address)
			.then(x => A.T(x, []) ? x[0].toString().trim() : x.toString().trim(), () => device.host.address)
			.then(x =>
				x.toLowerCase().endsWith(adapter.config.ip) ? x.slice(0, -adapter.config.ip.length) : x)
			.then(x => device.name = typ + ':' + x.split('.').join('-'))
			.then(x => {
				if (scanList[x]) {
					return A.W(`Device found already: ${x} with ${A.O(device.host)}`);
				}
				device.host.name = x;
				device.host.mac = Array.prototype.slice.call(device.mac, 0).map(s => s.toString(16)).join(':');
				A.I(`Device ${x} dedected: ${A.O(device.host)}`);
				scanList[x] = device;
				device.iname = x;
				switch (device.typ) {
					case 'SP':
						device.oval = undefined;
						device.on('payload', (err, payload) => {
							let res = !!payload[4];
							if (payload !== null && (payload[0] == 1 || payload[0] == 2)) {
								if (device.oval !== res) {
									device.oval = res;
									return A.makeState({
										id: x,
										write: true,
										role: 'switch',
										type: typeof true,
										native: {
											host: device.host
										}
									}, res, true);
								}
							} else A.W(`Device ${x} sent err:${err}/${err.toString(16)} with ${payload.toString('hex')}`);
						});
						break;
					case 'RM':
						device.ltemp == undefined;
						device.on('temperature', (val) => {
							//							A.D(`Received temperature ${val} from ${x}`);
							if (device.ltemp !== val) {
								device.ltemp = val;
								A.makeState({
									id: x + tempName,
									role: "value.temperature",
									write: false,
									unit: "°C",
									type: typeof 1.1
								}, val, true);
							}
						});
						A.makeState({
							id: x + learnName,
							write: true,
							role: 'button',
							type: typeof true,
							native: {
								host: device.host
							}
						}, false, true).then(() => A.makeState({
							id: x + sendName,
							role: "text",
							write: true,
							type: typeof ''
						}, ' ', true));
						break;
					case 'A1':
						device.on("payload", function (err, payload) {
							let nst = x + tempName;
							if (!payload)
								return;

							var param = payload[0];
							switch (param) {
								case 1:

									var nnLight = {
										0: "dunkel",
										1: "dämerung",
										2: "normal",
										3: "hell"
									};
									var nnair = {
										0: "sehr gut",
										1: "gut",
										2: "normal",
										3: "schlecht"
									};
									var nnnoise = {
										0: "ruhig",
										1: "normal",
										2: "laut"
									};

									data = {
										temperature: (payload[0x4] * 10 + payload[0x5]) / 10.0,
										humidity: (payload[0x6] * 10 + payload[0x7]) / 10.0,
										light: payload[0x8],
										air_quality: payload[0x0a],
										noise: payload[0xc],
									};
									A.makeState(x + tempName, data.temperature, {
										name: device.name,
										host: device.host,
										type: typeof 1.1,
										role: "value.temperature",
										write: false,
										unit: "°C"
									});
									A.makeState(x + humName, data.humidity, {
										name: device.name,
										host: device.host,
										type: typeof 1.1,
										role: "value.temperature",
										write: false,
										unit: "°C"
									})
									A.makeState(x + lightName, nnLight[data.light], {
										name: device.name,
										host: device.host,
										type: typeof "string"
									});
									A.makeState(x + lightRAWName, data.light, {
										name: device.name,
										host: device.host,
										type: typeof 1
									});
									A.makeState(x + airQualityName, nnair[data.air_quality], {
										name: device.name,
										host: device.host,
										type: typeof "string"
									});
									A.makeState(x + airQualityRAWName, data.air_quality, {
										name: device.name,
										host: device.host,
										type: typeof 1
									});
									A.makeState(x + noiseName, nnnoise[data.noise], {
										name: device.name,
										host: device.host,
										type: typeof "string"
									});
									A.makeState(x + noiseRAWName, data.noise, {
										name: device.name,
										host: device.host,
										type: typeof 1
									});

									break;
								case 4: //get from check_data
									var data = Buffer.alloc(payload.length - 4, 0);
									payload.copy(data, 0, 4);
									//this.emit("rawData", data);
									this.emitter.emit("rawData", data);
									break;
								case 3:
									break;
								case 4:
									break;
							}
						})
						break;
				}
			}).catch(e => A.W(`Error in device dedect: "${e}"`));
		return false;
	}).discover();

	A.D('Config IP-Address end to remove: ' + adapter.config.ip);
	A.seriesOf(adapter.config.scenes, scene =>
			A.makeState({
				id: scenesName + '.' + scene.name.trim(),
				write: true,
				role: 'button',
				type: typeof true,
				native: {
					scene: scene.scene
				}
			}), 100).then(() => A.wait(9000))
		.then(() => doPoll())
		.then(() => A.makeState({
			id: scanName,
			write: true,
			role: 'button',
			type: typeof true,
		}, false, true))
		.then(() => A.makeState({
			id: sceneName,
			write: true,
			role: 'text',
			type: typeof '',
		}, ' ', true))
		.then(() => {
			const p = parseInt(adapter.config.poll);
			if (p) {
				setInterval(doPoll, p * 1000);
				A.D(`Poll every ${p} secods.`);
			}
		})
		.then(() => A.I(`Adapter ${A.ains} started and found ${Object.keys(scanList).length} devices named '${Object.keys(scanList).join("', '")}'.`), e => A.W(`Error in main: ${e}`))
		.catch(e => A.W(`Unhandled error in main: ${e}`));
}