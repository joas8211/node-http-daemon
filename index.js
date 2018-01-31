const net = require('net');
const dns = require('dns');
const http = require('http');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const SOCKET_ROOT = path.join(__dirname, 'sockets');

/**
 * Generate cross-platform socket path
 * @private
 */
function makeSocketPath(name) {
	let socketPath = path.join(SOCKET_ROOT, name + '.sock');
	if (process.platform === 'win32') {
		// TODO: test this on Windows
		socketPath = path.join('\\\\?\\pipe', socketPath);
	}
	return socketPath;
}

/**
 * Create RegExp out of string with wildcards
 * @private
 */
function wildcards(rule) {
	rule = rule.replace(/[\-\[\]\/\{\}\(\)\+\.\\\^\$\|]/g, '\\$&');
	rule = rule.replace(/[\?]/g, '.');
	rule = rule.replace(/[\*]/g, '.+');
	return new RegExp(rule);
}

/**
 * Pipe request to a socket
 * @private
 */
function pipeRequest(req, res, socketPath) {
	const _req = http.request({ socketPath }, (_res) => {
		_res.pipe(res, { end: true });
	});
	req.pipe(_req, { end: true });
}

/**
 * @typedef ApplicationOptions
 * @property {string} module Path to module to bind
 * @property {number} [port=80] Port to listen
 * @property {string} [host=0.0.0.0] Host to listen
 * @property {string} [vhost] vhost to filter requests with
 * @property {string} [basepath=/] Path to filter requests with
 */

/**
 * There should only be one instance per installation.
 * Static methods are used to interact with the instance
 * between processes using IPC with unix-socket or pipes.
 */
class HTTPDaemon {
	/**
	 * Construct a daemon
	 * 
	 * @private
	 */
	constructor() {
		/**
		 * HTTP servers
		 * 
		 * @type {Object.<string, Object.<number, http.Server>>}
		 * @private
		 */
		this.servers = {};

		/**
		 * Bound applications
		 * 
		 * @type {Object.<string, Object.<number, ApplicationOptions[]>>}
		 * @private
		 */
		this.applications = {};

		// Create socket root directory
		if (fs.existsSync(SOCKET_ROOT)) {
			let i = 0;
			while (fs.existsSync(SOCKET_ROOT + i)) i++;
			SOCKET_ROOT = SOCKET_ROOT + i;
		}

		process.umask(0o002);
		fs.mkdirSync(SOCKET_ROOT);

		/**
		 * Server for IPC
		 * 
		 * @type {net.Server}
		 * @private
		 */
		this.ipc = net.createServer();
		this.ipc.listen(HTTPDaemon.socketPath);
		this.ipc.on('connection', (socket) => {
			socket.on('data', (buffer) => {
				try {
					const args = JSON.parse(buffer);
					if (args instanceof Array) {
						const method = args.shift();
						if (typeof this[method] === 'function') {
							const ret = this[method].apply(this, args);
							if (ret instanceof Promise) {
								ret.then((val) => {
									socket.write(JSON.stringify(val));
									socket.end();
								}).catch((err) => {
									// TODO: handle error on client
									console.error(err);
									socket.end();
								});
							} else {
								socket.end();
							}
						} else {
							socket.end();
						}
					}
				} catch (err) {
					console.error(err);
					socket.end();
				}
			});
		});

		// Stop daemon on exit
		process.on('exit', () => this.stop());
		process.on('SIGINT', () => this.stop());
		process.on('SIGUSR1', () => this.stop());
		process.on('SIGUSR2', () => this.stop());
		// process.on('uncaughtException', () => this.stop());
	}

	/**
	 * Start the daemon
	 */
	static start() {
		return new HTTPDaemon();
	}

	/**
	 * Stop the daemon
	 * 
	 * @todo Stop applications and servers
	 * @private
	 */
	stop() {
		this.ipc.close(); 
		
		for (const host of Object.keys(this.servers)) {
			for (const port of Object.keys(this.servers[host])) {
				this.servers[host][port].close();
			}
		}

		if (fs.existsSync(SOCKET_ROOT)) fs.rmdirSync(SOCKET_ROOT);
	}
	

	/**
	 * Bind new application or get existing.
	 * 
	 * Filter to using vhost and basepath
	 * to allow listening multiple applications.
	 * 
	 * @param {ApplicationOptions} app Options for listening
	 * @returns {Promise<{id: string, socketPath: string}>}
	 * @private
	 */
	listen(app) {
		app.port = app.port || 80;
		app.host = app.host || '0.0.0.0';
		app.basepath = app.basepath || '/';

		return new Promise((resolve, reject) => {
			if (!fs.existsSync(app.module)) {
				// TODO: Improve message
				reject(new Error('Module does not exists'));
				return;
			}

			// Resolve host
			dns.lookup(app.host, (err, address, family) => {
				app.host = address;

				if (err) {
					reject(err);

					return;
				}

				// Check if application already exists
				// or add it to the list
				let exists = false;
				if (!this.applications[app.host]) {
					this.applications[app.host] = {};
				}
				if (!this.applications[app.host][app.port]) {
					this.applications[app.host][app.port] = [];
				}
				for (const _app of this.applications[app.host][app.port]) {
					if (
						_app.port === app.port &&
						_app.host === app.host &&
						(
							!_app.vhost ||
							!app.vhost ||
							_app.vhost === app.vhost
						) &&
						_app.basepath === app.basepath
					) {
						if (_app.module === app.module) {
							exists = true;
							app = _app;
						} else {
							// TODO: Improve message
							reject(new Error('Application collision'));
							return;
						}

					}
				}
				if (!exists) {
					const index = this.applications[app.host][app.port].push(app) - 1;
					app.id = `${app.host}_${app.port}_${index}`;
					app.socketPath = makeSocketPath(app.id);
					app.queue = [];
				}

				// If there's no server for the host, create one
				if (!this.servers[app.host]) {
					this.servers[app.host] = {};
				}
				if (!this.servers[app.host][app.port]) {
					const server = http.createServer();

					server.listen(app.port, app.host);
					server.on('request', this.handleRequest.bind(this, server));

					this.servers[app.host][app.port] = server;
				}

				const {id, socketPath} = app;
				resolve({id, socketPath});
			});
		});
	}

	/**
	 * Fired by application after it started listening.
	 * 
	 * @param {string} id Id of the application
	 * @private
	 */
	listening(id) {
		let [host, port, index] = id.split('_');
		port = parseInt(port);
		index = parseInt(index);
		const app = this.applications[host][port][index];

		// Replay queued requests
		if (fs.existsSync(app.socketPath)) {
			for (const {req, res} of app.queue) {
				pipeRequest(req, res, app.socketPath);
			}
			app.queue = [];
		}
	}

	/**
	 * Handle HTTP request
	 * 
	 * @private
	 */
	handleRequest(server, req, res) {
		const addr = server.address();
		const apps = this.applications[addr.address][addr.port];

		// Find applications that match `host` header value
		let hostFound = false;
		for (const app of apps) {
			if (
				(
					!app.vhost ||
					wildcards(`${app.vhost}:${app.port}`).test(req.headers.host)
				) &&
				req.url.indexOf(app.basepath) === 0
			) {
				hostFound = true;

				// Pipe the request to application's socket if it's open
				// or add it to a queue and start the application.
				if (fs.existsSync(app.socketPath)) {
					pipeRequest(req, res, app.socketPath);
				} else {
					app.queue.push({ req, res });
					child_process.fork(app.module);
				}
			}
		}

		if (!hostFound) {
			res.writeHead(404);
			res.end();
		}
	}


	/**
	 * Execute method on the daemon
	 * 
	 * @param {string} method Method to execute
	 * @param {Array} args Arguments
	 * 
	 * @return {Promise}
	 * @private
	 */
	static exec(method, args) {
		args.unshift(method);
		
		return new Promise((resolve, reject) => {
			net.connect(HTTPDaemon.socketPath, function () {
				if (!this.write(JSON.stringify(args))) {
					throw new Error('Could not send action to the daemon through socket');
				}
			}).on('data', (data) => {
				resolve(JSON.parse(data));
			}).on('error', (err) => {
				reject(err);
			}).on('close', (had_error) => {
				if (had_error) reject();
				else resolve();
			});
		});
	}

	/**
	 * Stop the daemon
	 */
	static stop() {
		HTTPDaemon.exec('stop', []);
	}

	/**
	 * Bind new application or get existing.
	 * 
	 * Filter to using vhost and basepath
	 * to allow listening multiple applications.
	 * 
	 * @param {ApplicationOptions} app Options for listening
	 * 
	 * @returns {Promise<http.Server>}
	 */
	static listen(app) {
		app.module = app.module || process.mainModule.filename;
		app.port = app.port || 80;
		app.host = app.host || '0.0.0.0';
		app.basepath = app.basepath || '/';

		return HTTPDaemon.exec('listen', [app]).then(({id, socketPath}) => {
			app.id = id;
			app.socketPath = socketPath;

			const server = http.createServer();
			server.listen(socketPath);

			HTTPDaemon.exec('listening', [app.id]);
			return Promise.resolve(server);
		})
	}
}

/**
 * Path to socket that's used for
 * inter-process communication with the daemon.
 * 
 * @member HTTPDaemon.socketPath
 * @private
 */
HTTPDaemon.socketPath = makeSocketPath('daemon');

module.exports = HTTPDaemon;

if (require.main === module) {
	const program = process.argv.slice(0, 2).map((a) => path.basename(a)).join(' ');
	const command = process.argv.slice(2).join(' ');
	switch (command) {
		case 'start-daemon':
			HTTPDaemon.start();
			break;

		case 'stop-daemon':
			HTTPDaemon.stop();
			break;

		case 'help':
		case '--help':
		case '-h':
		case '':
			console.info(`\nUsage: ${program} [command]`)
			console.log('\nCommands:\n');
			console.log('   start-daemon');
			console.log('   stop-daemon\n');
			break;

		default:
			console.log(`Command '${command}' does not exist.`);
	}
}