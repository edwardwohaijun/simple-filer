var Peer = require('simple-peer');

function Filer({myID, ws}){
  this.signalingChannel = ws || null;
  this.myID = myID || '';
}
Filer.prototype.peers = {};
Filer.prototype.tasks = [];

Filer.prototype._createPeerConnection = function (offerUID, answerUID, initiator, signalingChannel) { // todo 用obj作为参数， 而非多个individual arguments
  var p = this.peers[ initiator ? answerUID : offerUID ] = new Peer({initiator: initiator, trickle: true});


  p.on('signal', function (signalingData) {
    if (p.initiator) {
      signalingChannel.send(JSON.stringify({msgType: 'signaling', from: offerUID, to: answerUID, signalingData: signalingData}))
    } else {
      signalingChannel.send(JSON.stringify({msgType: 'signaling', from: answerUID, to: offerUID, signalingData: signalingData}))
    }
  });

  p.on('connect', function(){
    console.log('connected, beging sending');
    //this._runTask();
    //size[0] = 0; size[1] = 99;
    //this.peers[fileInfo.sentTo].send('fuck');

    var size = new Uint8Array(2); size[0] = 99; size[1] = 88;
    //var shit = new Uint8Array([22, 33]);
    //p.send(new Uint8Array([111, 222, 333]));
    p.send(new Uint8Array([32]))
  });

  p.on('data', function(data){
    console.log('data coming: ', data);
    //this._parseData(data);
  });

  p.on('close', function(){
    console.log('peer is closed')
  });

  p.on('error', function(err){
    console.log('peer error: ', err)
  });

  return p
};

Filer.prototype.handleSignaling = function(data){ // don't put p.on('data') handler inside this function
  var p = this.peers[data.from]; // in trickle mode, this signalingHandler would be called many times
  if (!p){ // I'm answerer(initiator == false)
    p = this._createPeerConnection(data.from, this.myID, false, this.signalingChannel);
  }
  p.signal(data.signalingData);
};

Filer.prototype._runTask = function(){
  var t;
  for(let i = 0; i < this.tasks.length; i++) {
    if (this.tasks[i].status == 'pending') {
      this.tasks[i].status = 'running';
      t = this.tasks[i];
      break
    }
  }
  if (t) {
    if (t.from == this.myID) { // I'm the file sender
      //this.peers[t.to].send("the file you want is: " + t.file.name + ' fileID: ' + t.file.id);
      this._sendFile({fileID: t.file.id, fileSize: t.file.size, fileName: t.file.name, sentTo: t.to}) // sent OR send
    } else if (t.to == this.myID){ // I'm the file receiver
      this.peers[t.from].send("the file I want is: " + t.file.name + ' fileID: ' + t.file.id);
      this._receiveFile()
    } else {
      console.log('Oops')
    }
  }
};

Filer.prototype._parseData = function(data){
  //console.log('got data: ', String.fromCharCode.apply(null, new Uint16Array(data)));
  //console.log('got data: ', utf8ArrayToStr(data))
  console.log('got data: ', data)
};

Filer.prototype._sendFile = function(fileInfo){
  //console.log('fileInfo in _sendFile: ', fileInfo);
  //function makeFileMeta({fileID, fileSize, fileName}){ // 8 characters(16 bytes) to save ID, 8 bytes(big enough) to save size, variable size to save Name
  //var meta = makeFileMeta(fileInfo);
  //console.log('meta: ', meta, '/peer: ', this.peers[fileInfo.sentTo]);
  //this.peers[fileInfo.sentTo].send(meta);
  //console.log('is meta of Buffer type: ', Buffer.isBuffer(meta));
  //console.log('after converting to buffer: ', new Uint8Array(meta));
  //this.peers[fileInfo.sentTo].send(new Uint8Array(meta));
  //this.peers[fileInfo.sentTo].send('WTF?');
  //this.peers[fileInfo.sentTo].send(88);

  var size = new Uint8Array(2); size[0] = 0; size[1] = 99;
  //this.peers[fileInfo.sentTo].send('fuck');
  this.peers[fileInfo.sentTo].send(new Uint8Array(2));
};

Filer.prototype._receiveFile = function(){

};

Filer.prototype.send = function(toWhom, fileObj){
  if (!fileObj) throw Error("no file selected");
  if (!toWhom) throw Error("no peer selected");

  fileObj.id = randomString();
  //this.tasks.push({file: fileObj, from: this.myID, to: toWhom, status: 'pending'}); // status: running/pending/done
  var p = this.peers[toWhom];
  if (p && p.connected){ // peer exists and connected
    //this._runTask()
    console.log('p connected, sending...', new Uint8Array([1, 2, 3]));
    p.send(new Uint8Array([1,2,3]));
  } else if (p){ // peer exists, but not connected, still connecting
    console.log('p exist, but not ready');
    // doNothing, just wait
  } else { // peer doesn't exist yet, need to create
    console.log('p doesnt exist, create it now');
    this._createPeerConnection(this.myID, toWhom, true, this.signalingChannel);
  }
};

// 而且是否会发生: sender发送metaFile, 同时receiver发送 data fetch req, 同一个file只需一方发送即可???



Filer.prototype._setMyID = function(myID){
  this.myID = myID
};

/////////
function makeFetchReq(fileHash, chunkIdx){ // chunkIdx is supposed to fall into 0-255, which means the file is allowed to be 256*2M=512M at most
  var buf = new ArrayBuffer(82); // js中每个字符占据2个bytes, fileHash有40个字符，再加上 dataType, chunkIdx 这2个字节

  new Uint8Array(buf, 0, 1)[0] = 0;                      // file type，是固定值：0. 也可以用DataView，如：new DataView(buf, 0, 1).setUint8(0, 0); 但DataView相比而言性能较差
  new Uint8Array(buf, 1, 1)[0] = chunkIdx;               // chunkIdx,             new DataView(buf, 1, 1).setUint8(0, chunkIdx);
  var uint16 = new Uint16Array(buf, 2, 40); // Uint16Array的offset必须是2的倍数，不能offset一个byte. 3rd argument不是byte length，而是根据type...
  for(let i=0; i<uint16.length; i++){ // ...如本例是U16Array，80个bytes共40个元素，因此参数必须是40. uint16.length 是该数组的element个数，不是字节个数
    uint16[i] = fileHash.charCodeAt(i)
  }
  return buf;
}

////////////////////////////////////////////
//---------- data protocol -----------------
// first byte is data type: 0(fileMeta), receiver need to save this info(fileID/Name/Size) in his/her tasks, then send back the fileChunkReq
//                          1(fileChunkReq), receiver send the fileChunkReq(what chunk of which file that I need)
//                          3(fileChunk), after receiving receiver's fileChunkReq, sender grab the chunk from the file, then send it out(need forloop to finish the whole chunk)


function makeFileMeta(fileInfo){ // 8 characters(16 bytes) to save ID, 8 bytes(big enough) to save size, variable size to save Name
  //console.log('fileinfo: ', fileInfo);
  var buf = new ArrayBuffer( 8 + 8 + 16 + 128 ); // |dataType|fileSize|fileID|fileName|, filename is restricted to 64 character at most
  new Float64Array(buf, 0, 1)[0] = 0;
  new Float64Array(buf, 8, 1)[0] = fileInfo.fileSize;
  //new Uint8Array(buf, 0, 1)[0] = 199;
  console.log('buf in makeFileMeat: ', new Uint8Array(buf));
  var uint16 = new Uint16Array(buf,8, 8);
  for(let i=0; i<uint16.length; i++){
    uint16[i] = fileInfo.fileID.charCodeAt(i)
  }
  console.log('buf in makeFileMeat: ', buf);
  return buf;
}

function makeFileChunkReq(){

}

function makeFileChunk(){

}

// credit: https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
function randomString(length, chars) {
  length = length || 8;
  chars = chars || '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var result = '';
  for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function ab2str(buf) {
  return String.fromCharCode.apply(null, new Uint16Array(buf));
}

function str2ab(str) {
  var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i=0, strLen=str.length; i<strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

// credit: https://stackoverflow.com/questions/8936984/uint8array-to-string-in-javascript
var utf8ArrayToStr = (function () {
  var charCache = new Array(128);  // Preallocate the cache for the common single byte chars
  var charFromCodePt = String.fromCodePoint || String.fromCharCode;
  var result = [];

  return function (array) {
    var codePt, byte1;
    var buffLen = array.length;
    result.length = 0;

    for (var i = 0; i < buffLen;) {
      byte1 = array[i++];

      if (byte1 <= 0x7F) {
        codePt = byte1;
      } else if (byte1 <= 0xDF) {
        codePt = ((byte1 & 0x1F) << 6) | (array[i++] & 0x3F);
      } else if (byte1 <= 0xEF) {
        codePt = ((byte1 & 0x0F) << 12) | ((array[i++] & 0x3F) << 6) | (array[i++] & 0x3F);
      } else if (String.fromCodePoint) {
        codePt = ((byte1 & 0x07) << 18) | ((array[i++] & 0x3F) << 12) | ((array[i++] & 0x3F) << 6) | (array[i++] & 0x3F);
      } else {
        codePt = 63;    // Cannot convert four byte code points, so use "?" instead
        i += 3;
      }
      result.push(charCache[codePt] || (charCache[codePt] = charFromCodePt(codePt)));
    }

    return result.join('');
  };
})();

module.exports = Filer;
