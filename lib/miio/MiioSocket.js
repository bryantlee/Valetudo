// @ts-check
const dgram = require("dgram");
const Codec = require("./Codec");
const Stamp = require("./Stamp");
const TimeSyncPacket = require("./TimeSyncPacket");

/**
 * A UDP socket connected to a miio_client.
 * Performs encryption and decryption, and tracks message ids and retries to provide an easy
 * callback interface.
 * @param {object} options
 * @param {dgram.Socket} options.socket
 * @param {Buffer} options.token The crypto key for this connection.
 * @param {string} options.deviceId The unique Device-id of your robot
 * @param {object|undefined} options.rinfo (object with 'port' and 'address' or undefined)
 * @param {number|undefined} options.timeout timeout in milliseconds to wait for a response
 * @param {function} options.onMessage
 * @param {function} options.onConnected function to call after completing a handshake
 * @param {string} options.name Name used to disambiguate logging messages
 */
const MiioSocket = function(options) {
    /** @const {Codec} */
    this.codec = new Codec({token: options.token});
    this.deviceId = options.deviceId;
    this.socket = options.socket;
    this.rinfo = options.rinfo;
    this.timeout = options.timeout || 500; // default timeout: 0.5s
    this.name = options.name;

    this.nextId = 1;
    this.stamp = new Stamp({});
    // id: {timeout: function, callback: function}
    this.pendingRequests = {};
    this.onMessage = options.onMessage;
    this.onConnected = options.onConnected;
    this.connected = false;

    this.socket.on("message", (incomingMsg, rinfo) => {
        this.rinfo = rinfo;

        const decodedResponse = this.codec.handleResponse(incomingMsg);
        const token = decodedResponse.token;
        if (token && token.toString("hex") !== "ffffffffffffffffffffffffffffffff" &&
            token.toString("hex") !== "00000000000000000000000000000000") {
            console.info("Got token from handshake:", decodedResponse.token.toString("hex"));
            this.token = token;
            this.codec.setToken(token);
        }
        this.deviceId = decodedResponse.deviceId;

        const msg = decodedResponse.msg;
        console.debug('incoming message', this.name, JSON.stringify(msg));
        this.stamp = new Stamp({val: decodedResponse.stamp});

        if (msg === null) {
            if (decodedResponse.stamp === 0) { // Initial TimeSync Packet
                console.debug("initial timesync packet");
                // Respond with current time
                const response = new TimeSyncPacket().header;
                this.socket.send(response, 0, response.length, this.rinfo.port, this.rinfo.address);
            }
        } else if (msg['result'] !== undefined && msg.id) {
            let pending = this.pendingRequests[msg.id];
            if (pending) {
                clearTimeout(pending.timeout_id);
                if (msg['error'])
                    console.info('error response', msg);
                pending.callback(msg['error'], msg['result']);
                delete this.pendingRequests[msg.id];
            } else {
                console.info("Received response for non-pending request:", JSON.stringify(msg));
            }
        } else if (msg['error']) {
            console.warn('unhandled error response', msg);
        } else {
            this.onMessage(msg);
        }
        if (!this.connected && this.onConnected) {
            this.connected = true;
            this.onConnected();
        }
    });
};

/** The default remote port. @const {int} */
MiioSocket.PORT = 54321;

/**
 * Used for both sending commands or responses.
 *
 * @param {object} msg JSON object to send to remote
 * @param {object} options
 * @param {number} options.timeout timeout in milliseconds
 * @param {function} options.callback callback on response
 * @param {function} options.onTimeout callback in case of timeout
 */
MiioSocket.prototype.sendMessage = function(msg, options) {
    if (!msg.id) {
        if (this.nextId > 0x7fffffff) { // assuming it's a signed 32bit integer
            this.nextId = 0;
        }
        msg.id = this.nextId++;
    }

    if (!msg.result) {
        this.pendingRequests[msg.id] = {
            callback: options.callback,
            timeout: function() {
                console.debug('request', msg.id, 'timed out');
                delete this.pendingRequests[msg.id];
                if (options.onTimeout) {
                    options.onTimeout();
                }
            }.bind(this)
        };
        this.pendingRequests[msg.id].timeout_id =
            setTimeout(this.pendingRequests[msg.id].timeout, options.timeout || this.timeout);
    }

    let packet = this.codec.encode(
        Buffer.from(JSON.stringify(msg), "utf8"),
        this.stamp.isValid() ? this.stamp : new Stamp({val: Date.now() / 1000}), this.deviceId);

    console.debug('sending', this.codec.token, this.rinfo.address, this.rinfo.port,
                  JSON.stringify(msg));
    this.socket.send(packet, 0, packet.length, this.rinfo.port, this.rinfo.address);
};

/**
 * Shutdown the socket.
 * @returns {Promise<void>}
 */
MiioSocket.prototype.shutdown = function() {
    return new Promise((resolve, reject) => {
        console.debug(this.name, "socket shutdown in progress...");

        try {
            this.socket.disconnect();
        } catch(err) {
            // do nothing, no connection is open
        }
        this.socket.close(() => {
            console.debug(this.name, "socket shutdown done");
            resolve();
        });
    });
};

module.exports = MiioSocket;