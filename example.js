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
