# Simple-filer

This library allows you to send/receive files(even bigger than your computer memory allows) between 2 browsers(Chrome only at this moment). The file data go directly from browserA to browserB using the data channel of WebRTC as the underlying transport layer.

# Install
```bash
npm install simple-filer
```
# Prerequisites
* Chrome browser
* Web Server with WebSocket support

# Usage
## server side
WebRTC needs a signaling server to exchange some meta data between peers before they can talk to each other directly.
The regular approach is to use WebSocket. The following snippet uses nodeJS as an example:
```javascript
var users = {}; // online users with key as userID, value as socket, data populated by your app
var express = require('express');
var app = express();
var httpServer = require('http').createServer(app);
httpServer.listen(8000);

const WebSocket = require('ws');
const wss = new WebSocket.Server({
  server: httpServer
});

wss.on('connection', function(socket){
  socket.on('message', msg => {
    var msgObj = JSON.parse(msg);

    switch (msgObj.msgType) {
      case "signaling":
        var targetClient = users[msgObj.to];
        targetClient.send(msg); // forward the signaling data to the specified user
        break;
      default: console.log('Oops, unknown msg: ', msgObj)
    }
  });
})
```
All you need to do is assign a message handler for `socket.on("message", msgHandler)`, `JSON.parse` the message, if the `msgObj.msgType` is `signaling`,
send the whole message to whoever `msgObj.to` points to.

## client side
```javascript
var ws = new WebSocket('ws://127.0.0.1:8000');
var Filer = require('simple-filer');
var filer = new Filer({myID: 123, signalingChannel: ws});

ws.onmessage = msg => {
  var msgObj = JSON.parse(msg.data);
  switch (msgObj.msgType) {
    case "signaling":
      filer.handleSignaling(msgObj);
      break;
  }
};

filer.on('task', function(task) { // when you are about to send/receive a file, task event is fired,
  console.log('new task: ', task); // this is where you can add file info on the webpage
});

filer.on('progress', function({fileID, progress, fileName, fileURL}){ // file transfer progress event
  console.log('file transfer progress: ', fileName, ': ', progress)
});

filer.on('status', function({fileID, status}){ // file transfer status: pending/sending/receiving/done/removed
  console.log('new status for ', fileID, ': ', status)
});
```
## Example app
Inside the example folder, there is a full-featured example app.
```bash
cd node_modules/simple-filer/example
npm install
npm run start
```
Open 2 Chrome tabs, go to `http://127.0.0.1:8000`, try to send files to each other.

If you want to run this example app in your local network, edit `example/public/javascripts/bundle.js`, search for `ws://127.0.0.1:8000`, change the IP address, then refresh the page.
You can also open `example/public/javascripts/src/demo.js` to know how it works, make some changes, then rebuild the JavaScript client code:
```bash
npm run build
npm run start
```

This example app works pretty well in local network(small office, home), because the data go directly between two browsers, it's even faster than data copy using thumb-drive.
Here is a running screenshot of this app:

![running demo](https://media.worksphere.cn/repo/simple-filer/demo-640.gif)


## API
### constructor
```javascript
var Filer = require('simple-filer');
var filer = new Filer({myID: 123, signalingChannel: ws, webrtcConfig: configObject, timeout: 12})
```
(You should only create one `filer` object in your web app.)

* `myID`- current user's ID provided by your application
* `signalingChannel`- WebRTC needs this channel to exchange meta data between peers. Usually, you can pass a connected WebSocket client.
* `timeout`- (optional) is how long it'd take making P2P connection before giving up. 
* `webrtcConfig`- (optional) passed to the underlying SimplePeer(an excellent WebRTC library) constructor. This argument should be like:
```
{iceServers: [{urls: 'stun:stun.l.google.com:19302'}, {urls: 'turn:SERVERIP:PORT', credential: 'secret', username: 'username'}, ...]}
```
SimplePeer already provides a default value for this argument, so you don't need one. 

Before you call `filer.send()` or `filer.createConnection()`, you should make sure at least `myID` and `signalingChannel` are ready.
If these 2 values are not ready when you create the filer object, you can: 
```javascript
var filer = new Filer({});
// moments later
filer.myID = 123;
filer.signalingChannel = socket;
filer._webrtcConfig = {iceServer: [{url: 'stun:stun.l.google.com:19302'}]};
// now you can begin sending file
filer.send(456, fileObj)
```

### handleSignaling
```
filer.handleSignaling(message)
```
Call this method when your WebSocket client has received a signaling message. The signaling message will have the following properties:
* `msgType` - its value is "signaling"
* `from` - message sender's userID
* `to` - message receiver's userID
* `signalingData` - signaling data generated by underlying WebRTC

Your websocket client should parse and handle the incoming signaling message:
```javascript
ws.onmessage = function(msg) {
  var msgObj = JSON.parse(msg.data);
  if (msgObj.msgType === "signaling") {
    filer.handleSignaling(msgObj);
  }
}
```    

### send
```
filer.send(receiverUID, file)
```
* `receiverUID` - the targeting user you want to send the file, UID is provided by your application
* `file` - the html file object.

After calling `filer.send()`, a new task event is fired for both sender and receiver. See `Events` section for further details

### createConnection
```javascript
filer.createConnection(peerID)
```
Sometimes, you want to make sure the P2P connection is established before attempting to send a file.
This function tries to create the connection. If Alice call `filer.createConnection(Bob)`, 
then Bob should **NOT** call `filer.createConnection(Alice)`. In WebRTC term, there should be only one offerer(Alice), 
one answerer(Bob). If either Alice or Bob is using a non-Chrome browser, the connection will fail. 
To check whether connection is established, they both need to listen on:
```javascript
filer.on('connect', function(peerID){ console.log("peerID: ", peerID, " connected") })
```
and
```javascript
filer.on('error/peer')
```
See `Events` section for further details. 

### removeTask
```
filer.removeTask(fileID)
```
When the file is received and saved successfully, you can choose to remove it by calling `removeTask(fileID)`.
It's recommended to call this method after you have saved the file in your hard drive, otherwise it'd take unnecessary space.

### FileSystemQuota
```
filer.FileSystemQuota()
  .then(({usedBytes, grantedByte}) => {console.log("used/granted", usedBytes, "/", grantedBytes})
  .catch(err => {console.log("err querying filesystem quota")})
```
This function returns a `Promise` with an object of 2 properties after resolve: `{usedBytes, grantedBytes}`,
As their name suggest, `usedBytes` is the sum of all received file size, `grantedBytes` is the total size you can use.
Chrome FileSystem is a sandboxed filesystem only accessible by Chrome browsers. As a file receiver, you need to make sure
the size of all incoming files don't exceed `grantedBytes - usedBytes`.

You can use this function to show `usedSize/totalSize` on page.
     
### removeAllFiles  
```javascript
filer.removeAllFiles()
  .then(filer.FileSystemQuota)
  .then(({usedBytes, grantedBytes}) => {console.log("available space: ", grantedBytes - usedBytes)})
  .catch(() => console.log("failed to remove some files"))
```
This function removes **ALL** files in Chrome filesystem. If you have another app also use `Chrome Filesystem API` to save files, they will be removed as well. 
It returns a `Promise` with no argument in success and error callback.
Generally, you can update filesystem quota value on page by passing `filer.FileSystemQuota` as success callback.

Clearing browser data will also remove all files in Chrome filesystem.

### isFileSystemAPIsupported
```
filer.isFileSystemAPIsupported
```
This is a bool property showing whether the client browser support FileSystem API(currently only Chrome does).
You might want to check this value to notify users to switch browser.

## Events
### connect
```javascript
filer.on('connect', function(peerID){ console.log("peer with ID: ", peerID, " connected")} )
```
Fired when P2P connection with peerID established.
### task
```
filer.on('task', function(taskData){ // add taskData on page})
```
Fired when you call `filer.send()` or when file receiver received a message about the incoming file.
This is the moment you add a html table row with the taskData. The taskData object has the following properties:
```javascript
{
  fileID, // randomly generated string
  fileName, fileSize, fileType, // self explained
  progress, // file transfer progress, at this moment it's 0. 
  from, to, // file sender's userID, file receiver's userID, both are provided by your app. 
  status // possible values are: pending/sending/receiving/done/removed
}
```

### progress
```
filer.on('progress, function({fileID, progress, fileName, fileURL}){ // update transfer progress})
```
Fired when part of the file has been sent/received. You can use this event to show a progress bar.
When the `progress` value hits 1 at receiving side, you can generate a link with `fileName` and `fileURL` for user to click and download(sender has no `fileURL`).

### status
```
filer.on('status', function({fileID, status}){})
```
Fired when status changed. There are 5 possible values during a file transfer:
* `pending` - wait for P2P connection to be established
* `sending` - file is sending
* `receiving` - file is receiving
* `done` - file is done sending or receiving
* `removed` - `filer.removeTask(fileID)` is called, all the underlying file data is removed

### error/peer
```
filer.on('error/peer', ({name, code, message, peerID}) => {})
```
Fired when peer-related errors occur, you'd better do a switch case on `code`, possible values are:
* `ERR_PEER_CLOSED` - peer closed connection
* `ERR_PEER_ERROR` - network disconnected 
* `ERR_PEER_CONNECTION_FAILED` - fail to create P2P connection due to timeout   

### error/file
```
filer.on('error/file', ({name, code, message, peerID, fileID}) => {})
```
Fired when file-transfer related errors occur, you'd better do a switch case on `code`, possible values are:
* `ERR_INVALID_PEERID` - the first peerID argument you pass to `filer.send(toWhom, fileObj)` is empty or null 
* `ERR_INVALID_FILE` - the second file argument you pass to `filer.send(toWhom, fileObj)` is not a html file object
* `ERR_UNKNOWN_MESSAGE_TYPE` - normally, this occurs when one browser is not Chrome
* `ERR_CHROME_FILESYSTEM_ERROR` - fail to read/write data from/to Chrome Filesystem, this occurs when you clear the browser cache during file receiving, 
remove the file when it's receiving, or you have exceeded your available Chrome Filesystem space.

# How does it work

First, each file, no matter its size, is sent/received in multiple chunks. Each chunk is of the size of `(64 * 1024 - 48) * 32 bytes`(a little bit less than 2M).
And the data is sent via data channel, the Chrome implementation of WebRTC allow the maximum message size in data channel to be 64k.
So, file senders need to run a loop of 32 iterations at most to send the whole chunk.

Let's say Alice want to send a bigger file to Bob. After their P2P connection has been established. The whole process can be illustrated in the following 2 diagrams:

![workflow of message exchange](https://media.worksphere.cn/repo/simple-filer/msgExchange.png)

![how chunk is sent/received](https://media.worksphere.cn/repo/simple-filer/HowChunkSentReceived.png?version=2)

Alice first send a meta data to Bob, containing information like: fileID(randomly generated string), fileName, fileSize, fileType.
After receiving the meta data, Bob create a local write buffer with the same size of a chunk, then
send the request for first chunk. Alice received the request, read the first chunk of the file into her local read buffer,
run a loop to send the whole chunk. When Bob received each piece of the chunk, he append them into his local write buffer first.
When the write buffer is full, he write the whole buffer into Chrome FileSystem, when the write is finished, Bob send the
request for the next chunk if this is not the last one.

# FAQ
## Can I use socket.io as signaling channel
Yes, you can pass a wrapper object to `Filer` constructor, like this:
```javascript
signalingChan = {
  socket: socket, // this is the socket.io client object
  send: function(data){
    this.socket.emit("signaling", data)
  },
};
var filer = new Filer({myID: 123, signalingChannel: signalingChan});
```

In your event handler function
```javascript
socket.on("signaling", function(signalingData){
  let signalingObj = JSON.parse(signalingData);
  filer.handleSignaling(signalingObj)
})
```

And your socket.io server should listen on `signaling` event, like this:
```javascript
let users = {}; // all online users, key is userID, value is socket object, populated by your app.
io.on('connection', function(socket){
  socket.on('signaling', function(signalingData){
    let signalingObj = JSON.parse(signalingData);
    let targetingUser = users[signalingObj.to]; // signalingObj.to is the ID of targeting user
    targetingUser.emit("signaling", signalingData)
  });
});
```

## Why Chrome only
WebRTC is a W3C standard, Firefox, Opera also support it(even Safari 11+ support it). But one advantage of Chrome is the FileSystem API support([Exploring the FileSystem APIs](https://www.html5rocks.com/en/tutorials/file/filesystem/)).
Data can be saved in a sanboxed file system which can only be accessed by Chrome. That means you can receive files bigger than your computer memory allowed.
Unfortunately, FileSystem API is Chrome-specific. I will consider adding support for Firefox/Safari in the future. 
But that mean it has to be a filesize limit. 

## Does it support NodeJS?
No for this moment, but technically, it can, and may require many time and effort. And I don't have any timeline to add NodeJS support.   

# Built with

* [Simple-peer](https://github.com/feross/simple-peer) - Simple WebRTC video/voice and data channels.


# Caveats
* This library is far from production ready, but it works well in small office, home.
* Although you can send many files to many peers at the same time, it's recommended against that.
JavaScript is not very efficient at handling binary data.

# Issues
When a file is in receiving, removing it might cause an error(refer to #1).

Besides, I have a personal chat web app([http://worksphere.cn/home](http://worksphere.cn/home), no registration needed).
I also created a dedicated discussion group in my chat app for this project. If you have more issues or suggestions, just go there.


# License

This project is licensed under the [MIT License](/LICENSE).
