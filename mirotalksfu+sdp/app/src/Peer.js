'use strict';

const Logger = require('./Logger');
const log = new Logger('Peer');
const { createSdpEndpoint } = require('mediasoup-sdp-bridge');

module.exports = class Peer {
    constructor(socket_id, data) {
        const { peer_info } = data;

        const {
            peer_uuid,
            peer_name,
            peer_presenter,
            peer_audio,
            peer_video,
            peer_video_privacy,
            peer_recording,
            peer_hand,
        } = peer_info;

        this.id = socket_id;
        this.peer_info = peer_info;
        this.peer_uuid = peer_uuid;
        this.peer_name = peer_name;
        this.peer_presenter = peer_presenter;
        this.peer_audio = peer_audio;
        this.peer_video = peer_video;
        this.peer_video_privacy = peer_video_privacy;
        this.peer_recording = peer_recording;
        this.peer_hand = peer_hand;

        this.sdpProducer = null;
        this.sdpConsumer = null;
        this.sdpOffer = null;

        this.transports = new Map();
        this.consumers = new Map();
        this.producers = new Map();
    }

    // ####################################################
    // UPDATE PEER INFO
    // ####################################################

    updatePeerInfo(data) {
        log.debug('Update peer info', data);
        switch (data.type) {
            case 'audio':
            case 'audioType':
                this.peer_info.peer_audio = data.status;
                this.peer_audio = data.status;
                break;
            case 'video':
            case 'videoType':
                this.peer_info.peer_video = data.status;
                this.peer_video = data.status;
                if (data.status == false) {
                    this.peer_info.peer_video_privacy = data.status;
                    this.peer_video_privacy = data.status;
                }
                break;
            case 'screen':
            case 'screenType':
                this.peer_info.peer_screen = data.status;
                break;
            case 'hand':
                this.peer_info.peer_hand = data.status;
                this.peer_hand = data.status;
                break;
            case 'privacy':
                this.peer_info.peer_video_privacy = data.status;
                this.peer_video_privacy = data.status;
                break;
            case 'presenter':
                this.peer_info.peer_presenter = data.status;
                this.peer_presenter = data.status;
                break;
            case 'recording':
                this.peer_info.peer_recording = data.status;
                this.peer_recording = data.status;
                break;
            default:
                break;
        }
    }

    // ####################################################
    // TRANSPORT
    // ####################################################

    getTransports() {
        return JSON.parse(JSON.stringify([...this.transports]));
    }

    getTransport(transport_id) {
        return this.transports.get(transport_id);
    }

    delTransport(transport_id) {
        this.transports.delete(transport_id);
    }

    addTransport(transport) {
        this.transports.set(transport.id, transport);
    }

    async connectTransport(transport_id, dtlsParameters) {
        if (!this.transports.has(transport_id)) {
            return false;
        }

        console.log("Calling to connect for", transport_id);
        await this.transports.get(transport_id).connect({
            dtlsParameters: dtlsParameters,
        });

        return true;
    }

    close() {
        this.transports.forEach((transport, transport_id) => {
            transport.close();
            this.delTransport(transport_id);
            log.debug('Closed and deleted peer transport', {
                //transport_id: transport_id,
                transportInternal: transport.internal,
                transport_closed: transport.closed,
            });
        });

        const peerTransports = this.getTransports();
        const peerProducers = this.getProducers();
        const peerConsumers = this.getConsumers();

        log.debug('CLOSE PEER - CHECK TRANSPORTS | PRODUCERS | CONSUMERS', {
            peer_id: this.id,
            peer_name: this.peer_name,
            peerTransports: peerTransports,
            peerProducers: peerProducers,
            peerConsumers: peerConsumers,
        });
    }

    // ####################################################
    // PRODUCER
    // ####################################################

    getProducers() {
        return JSON.parse(JSON.stringify([...this.producers]));
    }

    getProducer(producer_id) {
        return this.producers.get(producer_id);
    }

    delProducer(producer_id) {
        this.producers.delete(producer_id);
    }

    async createProducer(producerTransportId, producer_rtpParameters, producer_kind, producer_type) {
        if (!this.transports.has(producerTransportId)) return;

        const producerTransport = this.transports.get(producerTransportId);

        const producer = await producerTransport.produce({
            kind: producer_kind,
            rtpParameters: producer_rtpParameters,
        });

        const sdpEndpoint = createSdpEndpoint(producerTransport, producer_rtpParameters);
        this.sdpProducer = sdpEndpoint;

        const { id, appData, type, kind, rtpParameters } = producer;

        appData.mediaType = producer_type;

        this.producers.set(id, producer);

        if (['simulcast', 'svc'].includes(type)) {
            const { scalabilityMode } = rtpParameters.encodings[0];
            const spatialLayer = parseInt(scalabilityMode.substring(1, 2)); // 1/2/3
            const temporalLayer = parseInt(scalabilityMode.substring(3, 4)); // 1/2/3
            log.debug(`Producer [${type}-${kind}] ----->`, {
                scalabilityMode,
                spatialLayer,
                temporalLayer,
            });
        } else {
            log.debug('Producer ----->', { type: type, kind: kind });
        }

        //const offer = await this.createOfferSignal(producerTransportId, producer_rtpParameters);
        //this.sdpOffer = offer;

        console.log("Producer creado", this.peer_name);
        console.log("Transportes", this.transports.keys());
        console.log("Consumidores", this.consumers.keys());
        console.log("Productores", this.producers.keys());

        producer.on('transportclose', () => {
            log.debug('Producer "transportclose" event');
            this.closeProducer(id);
        });

        return producer;
    }

    closeProducer(producer_id) {
        if (!this.producers.has(producer_id)) return;

        const producer = this.getProducer(producer_id);
        const { id, kind, type, appData } = producer;

        try {
            producer.close();
        } catch (error) {
            log.warn('Close Producer', error.message);
        }

        this.delProducer(producer_id);

        log.debug('Producer closed and deleted', {
            peer_name: this.peer_name,
            kind: kind,
            type: type,
            appData: appData,
            producer_id: id,
            producer_closed: producer.closed,
        });
    }

    // ####################################################
    // CONSUMER
    // ####################################################

    getConsumers() {
        return JSON.parse(JSON.stringify([...this.consumers]));
    }

    getConsumer(consumer_id) {
        return this.consumers.get(consumer_id);
    }

    delConsumer(consumer_id) {
        this.consumers.delete(consumer_id);
    }

    async createConsumer(consumer_transport_id, producer_id, rtpCapabilities) {
        if (!this.transports.has(consumer_transport_id)) return;

        const consumerTransport = this.transports.get(consumer_transport_id);

        try {
            const consumer = await consumerTransport.consume({
                producerId: producer_id,
                rtpCapabilities,
                enableRtx: true, // Enable NACK for OPUS.
                paused: false,
            });
            //console.log("Consumer", consumer);

            const sdpEndpoint = createSdpEndpoint(consumerTransport, rtpCapabilities);
            this.sdpConsumer = sdpEndpoint;

            console.log("Setted sdpConsumer");

            sdpEndpoint.addConsumeData();

            sdpEndpoint.addConsumer(consumer);

            const { id, type, kind, rtpParameters, producerPaused } = consumer;

            this.consumers.set(id, consumer);


            if (['simulcast', 'svc'].includes(type)) {
                // simulcast - L1T3/L2T3/L3T3 | svc - L3T3
                const { scalabilityMode } = rtpParameters.encodings[0];
                const spatialLayer = parseInt(scalabilityMode.substring(1, 2)); // 1/2/3
                const temporalLayer = parseInt(scalabilityMode.substring(3, 4)); // 1/2/3
                try {
                    await consumer.setPreferredLayers({
                        spatialLayer: spatialLayer,
                        temporalLayer: temporalLayer,
                    });
                    log.debug(`Consumer [${type}-${kind}] ----->`, {
                        scalabilityMode,
                        spatialLayer,
                        temporalLayer,
                    });
                } catch (error) { }
            } else {
                log.debug('Consumer ----->', { type: type, kind: kind });
            }

            consumer.on('transportclose', () => {
                log.debug('Consumer "transportclose" event');
                this.removeConsumer(id);
            });

            console.log("Consumer creado", this.peer_name);
            console.log("Transportes", this.transports.keys());
            console.log("Consumidores", this.consumers.keys());
            console.log("Productores", this.producers.keys());

            return {
                consumer: consumer,
                params: {
                    producerId: producer_id,
                    id: id,
                    kind: kind,
                    rtpParameters: rtpParameters,
                    type: type,
                    producerPaused: producerPaused,
                },
            };
        } catch (error) {
            console.log("Error al crear consumidor", error);
        }

        return null;
    }

    removeConsumer(consumer_id) {
        if (!this.consumers.has(consumer_id)) return;

        const consumer = this.getConsumer(consumer_id);
        const { id, kind, type } = consumer;

        try {
            consumer.close();
        } catch (error) {
            log.warn('Close Consumer', error.message);
        }

        this.delConsumer(consumer_id);

        log.debug('Consumer closed and deleted', {
            peer_name: this.peer_name,
            kind: kind,
            type: type,
            consumer_id: id,
            consumer_closed: consumer.closed,
        });
    }

    // ####################################################
    // SDP USERS
    // ####################################################

    async createSDPProducer(transport_id, sdpOffer, rtpCapabilities) {
        if (!this.transports.has(transport_id)) return;
        console.log("Found Transport ID", transport_id);
        const transport = this.transports.get(transport_id);

        const sdpEndpoint = createSdpEndpoint(transport, rtpCapabilities);
        this.sdpProducer = sdpEndpoint;
        sdpEndpoint.addConsumeData();

        //console.log("Sdp offer", sdpOffer);

        const producers = await sdpEndpoint.processOffer(sdpOffer);
        let videoProducer = null;
        let audioProducer = null;

        console.log("Producers", producers);

        for (const producer of producers) {
            const { id, kind, type, rtpParameters, appData } = producer;

            this.producers.set(id, producer);

            if (kind == 'video') {
                videoProducer = producer;
                this.peer_video = true;
                this.peer_info.peer_video = true;
                appData.mediaType = "videoType";
            } else if (kind == 'audio') {
                audioProducer = producer;
                this.peer_audio = true;
                this.peer_info.peer_audio = true;
                appData.mediaType = "audioType";
            }

            if (['simulcast', 'svc'].includes(type)) {
                const { scalabilityMode } = rtpParameters.encodings[0];
                const spatialLayer = parseInt(scalabilityMode.substring(1, 2)); // 1/2/3
                const temporalLayer = parseInt(scalabilityMode.substring(3, 4)); // 1/2/3
                log.debug(`Producer [${type}-${kind}] ----->`, {
                    scalabilityMode,
                    spatialLayer,
                    temporalLayer,
                });
            } else {
                log.debug('Producer ----->', { type: type, kind: kind, id: id });
            }

            console.log("SDP Producer creado", this.peer_name);
            console.log("Transportes", this.transports.keys());
            console.log("Consumidores", this.consumers.keys());
            console.log("Productores", this.producers.keys());

            producer.on('transportclose', () => {
                log.debug('Producer "transportclose" event');
                this.closeProducer(id);
            });
        }
        return { video: videoProducer, audio: audioProducer };
    }

    async createOfferSignal() {
        //const consumer = await transport.consume({ producerId: producerId, rtpCapabilities: rtpCapabilities });
        //consumer.observer.on("layerschange", function() { console.log("layer changed!", consumer.currentLayers); });
        //this.sdpEndpoint.addConsumer(consumer);
        //this.consumers.push(consumer);

        const offerSignal = this.sdpConsumer.createOffer();

        // send offer to peer
        //signalServer.send(JSON.stringify(offerSignal));
        //console.log("Offer signal", offerSignal);

        return offerSignal;
    }

    async consumeSDPAnswer(sdpAnswer) {
        console.log("Consume SDP Answer");
        this.sdpConsumer.processAnswer(sdpAnswer);
    }
};
