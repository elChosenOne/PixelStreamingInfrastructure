const logging = require('./modules/logging.js');
const server = require('../Server.js');

logging.RegisterConsoleLogger();

logging.RegisterFileLogger('./logs/');

var streamerPort = 8888; // port to listen to Streamer connections

var clientConfig = { type: 'config', peerConnectionOptions: {} };

console.logColor(logging.Cyan, `Running Cirrus - The Pixel Streaming reference implementation signalling server for Unreal Engine 5.2.`);

let nextPlayerId = 1;

const StreamerType = { Regular: 0, SFU: 1 };

class Streamer {
	constructor(initialId, ws, type) {
		//console.log("Constructor Streamer");
		this.id = initialId;
		this.ws = ws;
		this.type = type;
		this.idCommitted = false;
		this.peerData = null;

		this.rtpCapabilities = null;
		this.producer_transport_id = null;
		this.consumer_transport_id = null;
	}

	// registers this streamers id
	commitId(id) {
		//console.log("Commit ID Streamer");
		this.id = id;
		this.idCommitted = true;
	}

	// returns true if we have a valid id
	isIdCommitted() {
		//console.log("Is ID Committed Streamer");
		return this.idCommitted;
	}

	// links this streamer to a subscribed SFU player (player component of an SFU)
	addSFUPlayer(sfuPlayerId) {
		//console.log("Add SFU Player Streamer");
		if (!!this.SFUPlayerId && this.SFUPlayerId != sfuPlayerId) {
			//console.error(`Streamer ${this.id} already has an SFU ${this.SFUPlayerId}. Trying to add ${sfuPlayerId} as SFU.`);
			return;
		}
		this.SFUPlayerId = sfuPlayerId;
	}

	// removes the previously subscribed SFU player
	removeSFUPlayer() {
		//console.log("Remove SFU Player Streamer");
		delete this.SFUPlayerId;
	}

	// gets the player id of the subscribed SFU if any
	getSFUPlayerId() {
		//console.log("Get SFU Player ID Streamer");
		return this.SFUPlayerId;
	}

	// returns true if this streamer is forwarding another streamer
	isSFU() {
		//console.log("Is SFU Streamer");
		return this.type == StreamerType.SFU;
	}

	// links this streamer to a player, used for SFU connections since they have both components
	setSFUPlayerComponent(playerComponent) {
		//console.log("Set SFU Player Component Streamer");
		if (!this.isSFU()) {
			//console.error(`Trying to add an SFU player component ${playerComponent.id} to streamer ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuPlayerComponent = playerComponent;
	}

	// gets the player component for this sfu
	getSFUPlayerComponent() {
		//console.log("Get SFU Player Component Streamer");
		if (!this.isSFU()) {
			//console.error(`Trying to get an SFU player component from streamer ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuPlayerComponent;
	}
}

const PlayerType = { Regular: 0, SFU: 1 };
const WhoSendsOffer = { Streamer: 0, Browser: 1 };

class Player {
	constructor(id, ws, type, whoSendsOffer) {
		//console.log("Constructor Player");
		this.id = id;
		this.ws = ws;
		this.type = type;
		this.whoSendsOffer = whoSendsOffer;
	}

	isSFU() {
		//console.log("Is SFU Player");
		return this.type == PlayerType.SFU;
	}

	subscribe(streamerId) {
		//console.log("Subscribe Player");
		if (!streamers.has(streamerId)) {
			console.error(`subscribe: Player ${this.id} tried to subscribe to a non-existent streamer ${streamerId}`);
			return;
		}
		this.streamerId = streamerId;
		if (this.type == PlayerType.SFU) {
			let streamer = streamers.get(this.streamerId);
			streamer.addSFUPlayer(this.id);
		}
		const msg = { type: 'playerConnected', playerId: this.id, dataChannel: true, sfu: this.type == PlayerType.SFU, sendOffer: this.whoSendsOffer == WhoSendsOffer.Streamer };
		logOutgoing(this.streamerId, msg);
		this.sendFrom(msg);
	}

	unsubscribe() {
		//console.log("Unsubscribe Player");
		if (this.streamerId && streamers.has(this.streamerId)) {
			if (this.type == PlayerType.SFU) {
				let streamer = streamers.get(this.streamerId);
				if (streamer.getSFUPlayerId() != this.id) {
					console.error(`Trying to unsibscribe SFU player ${this.id} from streamer ${streamer.id} but the current SFUId does not match (${streamer.getSFUPlayerId()}).`)
				} else {
					streamer.removeSFUPlayer();
				}
			}
			const msg = { type: 'playerDisconnected', playerId: this.id };
			logOutgoing(this.streamerId, msg);
			this.sendFrom(msg);
		}
		this.streamerId = null;
	}

	sendFrom(message) {
		//console.log("Send From Player");
		if (!this.streamerId) {
			//console.log("If 1 sendFrom Player");
			if (streamers.size > 0) {
				//console.log("If 2 sendFrom Player");
				this.streamerId = streamers.entries().next().value[0];
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. Defaulting to ${this.streamerId}`);
			} else {
				//console.log("Else 2 sendFrom Player");
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. No streamer connected so this message isn't going anywhere!`)
				return;
			}
		}

		// normally we want to indicate what player this message came from
		// but in some instances we might already have set this (streamerDataChannels) due to poor choices
		if (!message.playerId) {
			//console.log("If 3 sendFrom Player");
			message.playerId = this.id;
		}
		const msgString = JSON.stringify(message);

		let streamer = streamers.get(this.streamerId);
		if (!streamer) {
			console.error(`sendFrom: Player ${this.id} subscribed to non-existent streamer: ${this.streamerId}`);
		} else {
			//console.log("Sending message");
			streamer.ws.send(msgString);
		}
	}

	sendTo(message) {
		//console.log("Send To Player");
		const msgString = JSON.stringify(message);
		this.ws.send(msgString);
	}

	setSFUStreamerComponent(streamerComponent) {
		//console.log("Set SFU Streamer Component Player");
		if (!this.isSFU()) {
			//console.error(`Trying to add an SFU streamer component ${streamerComponent.id} to player ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuStreamerComponent = streamerComponent;
	}

	getSFUStreamerComponent() {
		//console.log("Get SFU Streamer Component Player");
		if (!this.isSFU()) {
			//console.error(`Trying to get an SFU streamer component from player ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuStreamerComponent;
	}
};

let streamers = new Map();		// streamerId <-> streamer
let players = new Map(); 		// playerId <-> player/peer/viewer
const LegacyStreamerPrefix = "__LEGACY_STREAMER__"; // old streamers that dont know how to ID will be assigned this id prefix.
const LegacySFUPrefix = "__LEGACY_SFU__"; 					// same as streamer version but for SFUs
const streamerIdTimeoutSecs = 5;

// gets the SFU subscribed to this streamer if any.
function getSFUForStreamer(streamerId) {
	//console.log("Get SFU For Streamer");
	if (!streamers.has(streamerId)) {
		//console.log("If 1 Get SFU For Streamer");
		return null;
	}
	const streamer = streamers.get(streamerId);
	const sfuPlayerId = streamer.getSFUPlayerId();
	if (!sfuPlayerId) {
		//console.log("If 2 Get SFU For Streamer");
		return null;
	}
	return players.get(sfuPlayerId);
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

let WebSocket = require('ws');

let sfuMessageHandlers = new Map();

function sanitizePlayerId(playerId) {
	//console.log("Sanitize Player ID");
	if (playerId && typeof playerId === 'number') {
		//console.log("If 1 Sanitize Player ID");
		playerId = playerId.toString();
	}
	return playerId;
}

function getPlayerIdFromMessage(msg) {
	//console.log("Get Player ID From Message");	
	return sanitizePlayerId(msg.playerId);
}

let uniqueLegacyStreamerPostfix = 0;
function getUniqueLegacyStreamerId() {
	//console.log("Get Unique Legacy Streamer ID");
	const finalId = LegacyStreamerPrefix + uniqueLegacyStreamerPostfix;
	++uniqueLegacyStreamerPostfix;
	return finalId;
}

function requestStreamerId(streamer) {
	//console.log("Request Streamer ID");
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
	//console.log("Sanitize Streamer ID");
	let maxPostfix = -1;
	for (let [streamerId, streamer] of streamers) {
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
	//console.log("Register Streamer");
	// remove any existing streamer id
	if (!!streamer.id) {
		//console.log("If 1 Register Streamer");
		// notify any connected peers of rename
		const renameMessage = { type: "streamerIDChanged", newID: id };
		let clone = new Map(players);
		for (let player of clone.values()) {
			//console.log("For Register Streamer");
			if (player.streamerId == streamer.id) {
				//console.log("If 2 Register Streamer");
				logOutgoing(player.id, renameMessage);
				player.sendTo(renameMessage);
				player.streamerId = id; // reassign the subscription
			}
		}
		streamers.delete(streamer.id);
	}
	// make sure the id is unique
	const uniqueId = sanitizeStreamerId(id);
	streamer.commitId(uniqueId);
	if (!!streamer.idTimer) {
		//console.log("If 3 Register Streamer");
		clearTimeout(streamer.idTimer);
		delete streamer.idTimer;
	}
	streamers.set(uniqueId, streamer);
	console.logColor(logging.Green, `Registered new streamer: ${streamer.id}`);
	connectToBTalk(streamer);
}

function onStreamerDisconnected(streamer) {
	//console.log("On Streamer Disconnected");
	if (!!streamer.idTimer) {
		//console.log("If 1 On Streamer Disconnected");
		clearTimeout(streamer.idTimer);
	}

	if (!streamer.id || !streamers.has(streamer.id)) {
		//console.log("If 2 On Streamer Disconnected");
		return;
	}

	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		//console.log("If 3 On Streamer Disconnected");
		const msg = { type: "streamerDisconnected" };
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
		disconnectAllPlayers(sfuPlayer.id);
	}
	disconnectAllPlayers(streamer.id);
	streamers.delete(streamer.id);
}

function onStreamerMessageId(streamer, msg) {
	//console.log("On Streamer Message ID");
	logIncoming(streamer.id, msg);

	//console.log("Streamer Message:", msg);

	let streamerId = msg.id;
	registerStreamer(streamerId, streamer);
}

function onStreamerMessagePing(streamer, msg) {
	//console.log("On Streamer Message Ping");
	logIncoming(streamer.id, msg);

	const pongMsg = JSON.stringify({ type: "pong", time: msg.time });
	streamer.ws.send(pongMsg);
}

function onStreamerMessageDisconnectPlayer(streamer, msg) {
	//console.log("On Streamer Message Disconnect Player");
	logIncoming(streamer.id, msg);

	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		//console.log("If 1 On Streamer Message Disconnect Player");
		player.ws.close(1011 /* internal error */, msg.reason);
	}
}

function onStreamerMessageLayerPreference(streamer, msg) {
	//console.log("On Streamer Message Layer Preference");
	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		//console.log("If 1 On Streamer Message Layer Preference");
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
	}
}

function forwardStreamerMessageToPlayer(streamer, msg) {
	console.log("Forward Streamer Message To Player");
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		//console.log("If 1 Forward Streamer Message To Player");
		delete msg.playerId;
		logForward(streamer.id, playerId, msg);
		player.sendTo(msg);
	} else {
		console.warn("No playerId specified, cannot forward message: %s", msg);
	}
}

/* Aqui enviar datos SDP a BTalk */
function SendSDPOffer(streamer, msg) {
	//console.log("Send SDP Offer");
	//console.log("Message from streamer", streamer.id, msg);
	connectSDP(streamer, msg.sdp);
}

let streamerMessageHandlers = new Map();
streamerMessageHandlers.set('endpointId', onStreamerMessageId);
streamerMessageHandlers.set('ping', onStreamerMessagePing);
streamerMessageHandlers.set('offer', SendSDPOffer);
streamerMessageHandlers.set('answer', sendAnswerToProducer);
streamerMessageHandlers.set('iceCandidate', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('disconnectPlayer', onStreamerMessageDisconnectPlayer);
streamerMessageHandlers.set('layerPreference', onStreamerMessageLayerPreference);

console.logColor(logging.Green, `WebSocket listening for Streamer connections on :${streamerPort}`)
let streamerServer = new WebSocket.Server({ port: streamerPort, backlog: 1 });
streamerServer.on('connection', function (ws, req) {
	console.logColor(logging.Green, `Streamer connected: ${req.connection.remoteAddress}`);

	const temporaryId = req.connection.remoteAddress;
	let streamer = new Streamer(temporaryId, ws, StreamerType.Regular);

	ws.on('message', (msgRaw) => {
		console.log("In Streamer Message");
		var msg;
		//console.log("Server - Message Raw: ", msgRaw);

		try {
			//console.log("Try 1 In Streamer Message");
			msg = JSON.parse(msgRaw);
		} catch (err) {
			//console.log("Catch 1 In Streamer Message");
			console.error(`Cannot parse Streamer message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		console.log("Message type", msg.type);
		let handler = streamerMessageHandlers.get(msg.type);
		//msg.type == 'offer' && console.log("Offer Message: ", msg);
		if (!handler || (typeof handler != 'function')) {
			//console.log("If 1 In Streamer Message");
			console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", streamer.id, msgRaw);

			console.error(`unsupported Streamer message type: ${msg.type}`);
			ws.close(1008, 'Unsupported message type');
			return;
		}
		handler(streamer, msg);
	});

	ws.on('close', function (code, reason) {
		console.error(`streamer ${streamer.id} disconnected: ${code} - ${reason}`);
		onStreamerDisconnected(streamer);
	});

	ws.on('error', function (error) {
		console.error(`streamer ${streamer.id} connection error: ${error}`);
		onStreamerDisconnected(streamer);
		try {
			ws.close(1006 /* abnormal closure */, `streamer ${streamer.id} connection error: ${error}`);
		} catch (err) {
			console.error(`ERROR: ws.on error: ${err.message}`);
		}
	});

	const configStr = JSON.stringify(clientConfig);
	logOutgoing(streamer.id, configStr)
	ws.send(configStr);

	requestStreamerId(streamer);
});

function forwardSFUMessageToStreamer(sfuPlayer, msg) {
	console.log("Forward SFU Message To Streamer");
	logForward(sfuPlayer.getSFUStreamerComponent().id, sfuPlayer.streamerId, msg);	// <-- Solo imprime la info
	msg.sfuId = sfuPlayer.id;
	sfuPlayer.sendFrom(msg);
}

async function connectToBTalk(streamer) {
	//console.log("Connect To BTalk");
	let playerId = sanitizePlayerId(nextPlayerId++);

	const playerComponent = new Player(playerId, { send: (msg) => {console.log("send", msg)} }, PlayerType.SFU, WhoSendsOffer.Streamer);
	playerComponent.setSFUStreamerComponent(streamer);
	players.set(playerId, playerComponent);
	onPlayerMessageSubscribe(playerComponent, { type: 'subscribe', streamerId: streamer.id });

	const id = streamer.id;
	const userData = {
		peer_name: "RolPlayer",
		peer_id: id,
		peer_uuid: "1234",
		peer_token: false,
		os_name: 'Windows',
		os_version: '10',
		browser_name: 'Chrome',
		browser_version: 126,
	};

	server.SDPCreateTransport(id, "1234", {peer_info: userData}).then((data) => {
		//console.log("BTSocket SocketOn SDPConnect");
		if (data.error) {
			console.log("SocketOn Error: ", data.error);
		} else {
			//console.log("BTSocket else 1");
			const { producer_transport_id, consumer_transport_id, rtpCapabilities } = data;

			console.log("Producer Transport ID: ", producer_transport_id);	
			console.log("Consumer Transport ID: ", consumer_transport_id);

			streamer.producer_transport_id = producer_transport_id;
			streamer.consumer_transport_id = consumer_transport_id;
			streamer.rtpCapabilities = rtpCapabilities;
		}
	});
}

async function connectSDP(streamer, sdpData) {
	//console.log("BTalk -> ", BTSocket);
	const id = streamer.id;

	server.SDPProduce(id, streamer.producer_transport_id, sdpData).then((data) => {
		//console.log("BTSocket SocketOn SDPConnect");
		if (data.error) {
			console.log("SocketOn Error: ", data.error);
		} else {
			//console.log("BTSocket else 1");
			const { sdpAnswer } = data;

			const answer = { type: "answer", sdp: sdpAnswer }
			const player = players.get("1");
			//console.log("Answer");
			forwardSFUMessageToStreamer(player, answer);
		
			server.SDPConsume(id, streamer.consumer_transport_id);
		}
	});
}

function onPlayerMessageSubscribe(player, msg) {
	//console.log("On Player Message Subscribe");
	logIncoming(player.id, msg);
	player.subscribe(msg.streamerId);
}

function disconnectAllPlayers(streamerId) {
	//console.log(`unsubscribing all players on ${streamerId}`);
	let clone = new Map(players);
	for (let player of clone.values()) {
		if (player.streamerId == streamerId) {
			// disconnect players but just unsubscribe the SFU
			const sfuPlayer = getSFUForStreamer(streamerId);
			if (sfuPlayer && player.id == sfuPlayer.id) {
				sfuPlayer.unsubscribe();
			} else {
				player.ws.close();
			}
		}
	}
}

function sendOfferToStreamer(streamerId, peerId, sdpOffer) {
  const offerSignal = {
    type: "offer",
    playerId: peerId,
    sdp: sdpOffer,
    sfu: true // indicate we're offering from sfu
  };
	//console.log("Streamers: ", streamers);
	if (!streamers.has(streamerId)) {
		console.error(`sendOfferToStreamer: Streamer ${streamerId} does not exist.`);
		return;
	}

	const streamer = streamers.get(streamerId);
	
	logForward(peerId, streamer.id, offerSignal);
	streamer.ws.send(JSON.stringify(offerSignal));

  // send offer to peer
  //signalServer.send(JSON.stringify(offerSignal));
}

function sendOfferToAllStreamers(peerId, sdpOffer) {
  const offerSignal = {
    type: "offer",
    playerId: peerId,
    sdp: sdpOffer,
    sfu: true // indicate we're offering from sfu
  };

	streamers.forEach((streamer) => {
		logForward(peerId, streamer.id, offerSignal);
		streamer.ws.send(JSON.stringify(offerSignal));
	});

  //send offer to peer
  //signalServer.send(JSON.stringify(offerSignal));
}

function sendAnswerToProducer(streamer, msg) {
	//console.log("Send Answer To Producer");
	//console.log("Streamer: ", streamer.id, msg.playerId);	
	//console.log("Producer Message: ", msg);
	server.SDPAnswer(streamer.id, msg.sdp)
}

module.exports.sendOfferToStreamer = sendOfferToStreamer;
module.exports.sendOfferToAllStreamers = sendOfferToAllStreamers;