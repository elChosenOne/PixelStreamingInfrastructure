// Copyright Epic Games, Inc. All Rights Reserved.

//-- Server side logic. Serves pixel streaming WebRTC-based page, proxies data back to Streamer --//
const logging = require('./modules/logging.js');

const server = require('../Server.js');

logging.RegisterConsoleLogger();

console.logColor(logging.Cyan, `Running Cirrus - The Pixel Streaming reference implementation signalling server for Unreal Engine 5.3.`);

let nextPlayerId = 1;

const StreamerType = { Regular: 0, SFU: 1 };

class Streamer {
	constructor(initialId, ws, type) {
		this.id = initialId;
		this.ws = ws;
		this.type = type;
		this.idCommitted = false;
	}

	// registers this streamers id
	commitId(id) {
		this.id = id;
		this.idCommitted = true;
	}

	// returns true if we have a valid id
	isIdCommitted() {
		return this.idCommitted;
	}

	// links this streamer to a subscribed SFU player (player component of an SFU)
	addSFUPlayer(sfuPlayerId) {
		if (!!this.SFUPlayerId && this.SFUPlayerId != sfuPlayerId) {
			console.error(`Streamer ${this.id} already has an SFU ${this.SFUPlayerId}. Trying to add ${sfuPlayerId} as SFU.`);
			return;
		}
		this.SFUPlayerId = sfuPlayerId;
	}

	// removes the previously subscribed SFU player
	removeSFUPlayer() {
		delete this.SFUPlayerId;
	}

	// gets the player id of the subscribed SFU if any
	getSFUPlayerId() {
		return this.SFUPlayerId;
	}

	// returns true if this streamer is forwarding another streamer
	isSFU() {
		return this.type == StreamerType.SFU;
	}

	// links this streamer to a player, used for SFU connections since they have both components
	setSFUPlayerComponent(playerComponent) {
		if (!this.isSFU()) {
			console.error(`Trying to add an SFU player component ${playerComponent.id} to streamer ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuPlayerComponent = playerComponent;
	}

	// gets the player component for this sfu
	getSFUPlayerComponent() {
		if (!this.isSFU()) {
			console.error(`Trying to get an SFU player component from streamer ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuPlayerComponent;
	}

	connectToBTalk() {
		console.logColor('\x1b[32m', `Sending playerConnected to Streamer: ${this.id}`);
		const msg = { type: 'playerConnected', playerId: "1", dataChannel: true, sfu: true, sendOffer: true };
		//console.log("Sending message: ", JSON.stringify(msg));
		//this.ws.send(JSON.stringify(msg));
	}
}

const LegacyStreamerPrefix = "__LEGACY_STREAMER__"; // old streamers that dont know how to ID will be assigned this id prefix.
const LegacySFUPrefix = "__LEGACY_SFU__"; 					// same as streamer version but for SFUs
const streamerIdTimeoutSecs = 5;

// gets the SFU subscribed to this streamer if any.
function getSFUForStreamer(streamerId) {
	if (!server.streamers.has(streamerId)) {
		return null;
	}
	const streamer = server.streamers.get(streamerId);
	const sfuPlayerId = streamer.getSFUPlayerId();
	if (!sfuPlayerId) {
		return null;
	}
	return server.players.get(sfuPlayerId);
}

function logIncoming(sourceName, msg) {
	console.logColor(logging.Blue, "\x1b[37m%s ->\x1b[34m %s", sourceName, JSON.stringify(msg));
}

function logOutgoing(destName, msg) {
	console.logColor(logging.Green, "\x1b[37m%s <-\x1b[32m %s", destName, JSON.stringify(msg));
}

function logForward(srcName, destName, msg) {
	console.logColor(logging.Cyan, "\x1b[37m%s -> %s\x1b[36m %s", srcName, destName, JSON.stringify(msg));
}

function sanitizePlayerId(playerId) {
	if (playerId && typeof playerId === 'number') {
		playerId = playerId.toString();
	}
	return playerId;
}

function getPlayerIdFromMessage(msg) {
	return sanitizePlayerId(msg.playerId);
}

let uniqueLegacyStreamerPostfix = 0;
function getUniqueLegacyStreamerId() {
	const finalId = LegacyStreamerPrefix + uniqueLegacyStreamerPostfix;
	++uniqueLegacyStreamerPostfix;
	return finalId;
}

let uniqueLegacySFUPostfix = 0;
function getUniqueLegacySFUId() {
	const finalId = LegacySFUPrefix + uniqueLegacySFUPostfix;
	++uniqueLegacySFUPostfix;
	return finalId;
}
function requestStreamerId(streamer) {
	// first we ask the streamer to id itself.
	// if it doesnt reply within a time limit we assume it's an older streamer
	// and assign it an id.

	// request id
	//console.log("Requesting Streamer ID");

	const msg = { type: "identify" };
	logOutgoing(streamer.id, msg);
	streamer.ws.send(JSON.stringify(msg));

	streamer.idTimer = setTimeout(function () {
		//console.log("Streamer ID Timeout");
		// streamer did not respond in time. give it a legacy id.
		const newLegacyId = getUniqueLegacyStreamerId();
		if (newLegacyId.length == 0) {
			const error = `Ran out of legacy ids.`;
			console.error(error);
			streamer.ws.close(1008, error);
		} else {
			//console.log("Streamer ID Timeout -> ", newLegacyId);
			registerStreamer(newLegacyId, streamer);
		}

	}, streamerIdTimeoutSecs * 1000);
}

function sanitizeStreamerId(id) {
	let maxPostfix = -1;
	for (let [streamerId, streamer] of server.streamers) {
		const idMatchRegex = /^(.*?)(\d*)$/;
		const [, baseId, postfix] = streamerId.match(idMatchRegex);
		// if the id is numeric then base id will be empty and we need to compare with the postfix
		if ((baseId != '' && baseId != id) || (baseId == '' && postfix != id)) {
			continue;
		}
		const numPostfix = Number(postfix);
		if (numPostfix > maxPostfix) {
			maxPostfix = numPostfix
		}
	}
	if (maxPostfix >= 0) {
		return id + (maxPostfix + 1);
	}
	return id;
}

function registerStreamer(id, streamer) {
	// remove any existing streamer id
	//console.log("Server:", server);
	//console.log("streamers: ", server.streamers);
	if (!!streamer.id) {
		// notify any connected peers of rename
		const renameMessage = { type: "streamerIDChanged", newID: id };
		let clone = new Map(server.players);
		console.log("clone: ", clone.keys());	
		for (let player of clone.values()) {
			if (player.streamerId == streamer.id) {
				logOutgoing(player.id, renameMessage);
				player.sendTo(renameMessage);
				player.streamerId = id; // reassign the subscription
			}
		}
		server.streamers.delete(streamer.id);
	}
	// make sure the id is unique
	const uniqueId = sanitizeStreamerId(id);
	streamer.commitId(uniqueId);
	if (!!streamer.idTimer) {
		clearTimeout(streamer.idTimer);
		delete streamer.idTimer;
	}
	server.streamers.set(uniqueId, streamer);
	console.logColor(logging.Green, `Registered new streamer: ${streamer.id}`);
	
	let clone = new Map(server.players);
	console.log("clone: ", clone.keys());	
	for (let player of clone.values()) {
		if (player.id == "1") {
			console.log("Subscribing player: ", player.id);
			player.streamerId = streamer.id;
			player.subscribe(streamer.id);

			//player.sendTo(renameMessage);
			//player.streamerId = id; // reassign the subscription
		}
	}

	setTimeout(() => {
		//streamer.connectToBTalk(streamer);
	}, 10000);
	
	//connectToBTalk(streamer);
}

function onStreamerMessageId(streamer, msg) {
	logIncoming(streamer.id, msg);

	//console.log("Streamer Message:", msg);*/

	let streamerId = msg.id;
	registerStreamer(streamerId, streamer);
}

function onStreamerMessagePing(streamer, msg) {
	logIncoming(streamer.id, msg);

	const pongMsg = JSON.stringify({ type: "pong", time: msg.time });
	streamer.ws.send(pongMsg);
}

function onStreamerMessageDisconnectPlayer(streamer, msg) {
	logIncoming(streamer.id, msg);
	
	const playerId = getPlayerIdFromMessage(msg);
	const player = server.players.get(playerId);
	if (player) {
		player.ws.close(1011 , msg.reason);
	}
}

function onStreamerMessageLayerPreference(streamer, msg) {
	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
	}
	//console.log("Layer Preference: ", msg);
}

function forwardStreamerMessageToPlayer(streamer, msg) {
	const playerId = getPlayerIdFromMessage(msg);
	const player = server.players.get(playerId);
	if (player) {
		delete msg.playerId;
		logForward(streamer.id, playerId, msg);
		player.sendTo(msg);
	} else {
		console.warn("No playerId specified, cannot forward message: %s", msg);
	}
	//console.log("Forwarding message to player: ", msg);
}

/* Aqui enviar datos SDP a BTalk */
function SendSDPOffer(streamer, msg) {
	//connectSDP(msg.sdp);
	console.log("SendSDPOffer: ", msg);
}

let streamerMessageHandlers = new Map();
streamerMessageHandlers.set('endpointId', onStreamerMessageId);
streamerMessageHandlers.set('ping', onStreamerMessagePing);
//streamerMessageHandlers.set('offer', SendSDPOffer);
streamerMessageHandlers.set('answer', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('iceCandidate', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('disconnectPlayer', onStreamerMessageDisconnectPlayer);
streamerMessageHandlers.set('layerPreference', onStreamerMessageLayerPreference);

module.exports.Streamer = Streamer;
module.exports.StreamerType = StreamerType;
module.exports.streamerMessageHandlers = streamerMessageHandlers;
module.exports.requestStreamerId = requestStreamerId;