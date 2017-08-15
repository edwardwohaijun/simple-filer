# Simple-filer

This library allows you to send files(even bigger than your memory allows) between 2 browsers(Chrome only at this moment). The file data go directly from browserA to browserB using the data channel of WebRTC as the underlying transport layer.

# Install
```bash
npm install simple-filer
```

# Usage
## server side
WebRTC needs a signaling server to exchange some meta data between peers before peers can talk to each other directly.
The regular approach is to use WebSocket. The following snippet uses nodeJS as an example:
```javascript
var users = {} // online users with key as userID, value as socket
const WebSocket = require('ws');
const wss = new WebSocket.Server({
  server: httpsServer
});

wss.on('connection', function(ws){
  ws.on('message', msg => {
    var msgObj = JSON.parse(msg);

    switch (msgObj.msgType) {
      case "signaling":
        var targetClient = users[msgObj.to];
        targetClient.send(msg) // forward the signaling data to the specified user
        break;
      default: console.log('Oops. unknown msg: ', msgObj)
    }
  });
})
```
All you need to do is parse the client message `{msgType: 'signaling', from: userID, to: userID, signalingData: data}`, and forward it to the specified user.

## client side
```javascript
var ws = new WebSocket('wss://127.0.0.1:8443');

var Filer = require('simple-filer')
var filer = new Filer({myID: 123, signalingChannel: ws})

ws.onmessage = msg => {
  var msgObj = JSON.parse(msg.data);
  switch (msgObj.msgType) {
    case "signaling":
      filer.handleSignaling(msgObj);
      break;
  }
};

filer.on('newTask', function(task) { // when you are about to send/receive a file, newTask event is fired
  console.log('new task: ', task); // this is where you can add task info on the webpage
});

filer.on('newProgress', function({fileID, progress, fileName, fileURL}){ // file transfer progress event
  console.log('file transfer progress: ', fileName, ': ', progress)
});

filer.on('newStatus', function({fileID, status}){ // file transfer status: pending/sending/receiving/done/removed
  console.log('new status for ', fileID, ': ', status)
});
```

## Example app
Inside the example folder, there is a full-featured example app.
```bash
cd example
npm install
npm run start
```
Open Chrome browser, go to `http://127.0.0.1:8443`. The first time you open this address, Chrome would show you a 'not secure' message.
That's because WebRTC requires WebServer to run on TLS. I use a self-signed certificate.

If you want to run this app in your local network, edit the `example/public/javascripts/bundle.js`, search for `var ws = new WebSocket('wss:`, change the IP address, then restart the app.
This example app works pretty well in local network(small office, home), because the data goes directly between two browsers, it's even faster than data copy using thumb-drive.

## Built with

* [Simple-peer](https://github.com/feross/simple-peer) - Simple WebRTC video/voice and data channels.

## Caveats
Although you can send many files to many peers(or the same peer) at the same time, it's recommended against that. JavaScript is not very efficient at handling binary data.

## License

This project is licensed under the [MIT License](/LICENSE.md).
