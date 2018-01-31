# Node HTTP Daemon

This is a solution for server which need to host multiple independend Node applications at the same time with the same port on the same machine.

**The development of this project has just started. It is not recommended to use at all it if you're not willing to participate in the development.**

## CLI
| Command                       | Action            |
| --------                      | -------           |
| `node index.js start-daemon`  | Start the daemon  |
| `node index.js stop-daemon`	| Stop the daemon	|

## API

### `HTTPDaemon.start()`
Start the daemon

### `HTTPDaemon.stop()`
Stop the daemon

### `HTTPDaemon.listen(app)`
Bind new application or get existing. Filter to using vhost and basepath to allow listening multiple applications.

#### Arguments
- `app` - Application options

| Name 		| Type 		| Attributes 	| Default 	| Description 					|
| -----		| -----		| -----------	| --------	| ------------					|
| module	| string	| optional		|			| Path to module to bind		|
| port		| number	| optional		| 80		| Port to listen				|
| host		| string	| optional		| 0.0.0.0	| Host to listen				|
| vhost		| string	| optional		|			| vhost to filter requests with	|
| basepath	| string	| optional		| /			| Path to filter requests with	|

#### Returns
`Promise.<http.Server>`

## Example

```javascript
const HTTPDaemon = require('./index.js');

// Start listening.
// This will reqister a new application to HTTP daemon
// and open HTTP server through it.
HTTPDaemon.listen({
	port: 8080,
	host: '127.0.0.1',
	vhost: 'localhost',
	basepath: '/foo',
}).then((server) => {
	// We don't need to worry about keeping the server
	// alive for requests. HTTP daemon will keep listening
	// on it and reopen this application when there's a new
	// request.
	
	let timeout;
	function resetTimeout() {
		clearTimeout(timeout);
		timeout = setTimeout(() => server.close(), 100);
	}
	resetTimeout();

	server.on('request', (req, res) => {
		resetTimeout();
		res.end('<h1>Hello World</h1>');
	});
});
```

## TODO
- Unbinding applications
- User and machine wide daemons
	- Unix socket directories
	- Handling file permissions better
	- Finding open daemon
- Error handling
- Debugging
- Investigate possibility of integration with traditional HTTP daemons like Apache or Nginx using extensions
