var Filer = require('simple-filer');
var filer = new Filer({});

filer.on('task', function(task) {
  addTask(task);
});

filer.on('progress', function({fileID, progress, fileName, fileURL}){
  var progressTD = $("#progress-" + fileID);
  progressTD.text(Math.floor(progress * 100) + '%');
  if (progress === 1 && fileURL){
    var fileNameTD = $("#fileName-" + fileID);
    fileNameTD.html("<a href='" + fileURL + "' download>" + fileName + "</a>")
  }
});

filer.on('status', function({fileID, status}){
  var statusTD = $("#status-" + fileID);
  statusTD.text(status);
  if (status === 'done' || status === 'removed') checkQuota()
});

filer.on('error/peer', function(err){
  switch (err.code){
    case "ERR_PEER_CLOSED":
      console.log("connection with peer ID ", err.peerID, " closed");
      break;
    case "ERR_PEER_ERROR": // the remote peer has closed the browser, lost network connection, stuff like that
      console.log('peer err: ', err.message); // if you are the file receiver, you have to ask file sender to re-establish P2P connection, and re-send the file.
      break;
    case "ERR_PEER_CONNECTION_FAILED": // failed to make P2P connection due to timeout(default is 12seconds, could be overridden by passing a timeout property to Filer constructor)
      console.log('peer connection error: ', err.message);
      break;
    default:
      console.log("Unknown peer error: ", err);
  }
});

filer.on('error/file', function(err){
  switch (err.code) {
    case "ERR_INVALID_PEERID": // you are calling filer.send() with an empty or null peerID
      console.log('invalid peerID', err.message);
      break;
    case "ERR_INVALID_FILE": // You are calling filer.send() with an invalid file object
      console.log('InvalidFileObject: ', err.message);
      break;
    case "ERR_UNKNOWN_MESSAGE_TYPE": // probably due to one side is using a non-Chrome browser, but I have done some checking to prevent that, thus I don't think this error would occur
      console.log("unknown data type", err.message);
      break;
    case "ERR_CHROME_FILESYSTEM_ERROR": // probably due to that you have exceeded your filesystem quota(your hard disk is almost full), or you are clearing browser cache during file receiving
      console.log("chrome FS error: ", err.message);
      break;
    default:
    console.log('unknown file error: ', err)
  }
});

var myID, selectedPeerID, users = {}, file; // file to be sent;

$("#inputFile").change(function(e){
  file = e.target.files[0];
});

// todo: if no peer selected, disable this button
$("#startTransfer").click(function(){
  filer.myID = myID;
  filer.signalingChannel = ws;
  filer.send(selectedPeerID, file)
});
if (!filer.isFileSystemAPIsupported) {
  $("#non-chrome-warning").text("Please use Chrome");
  $("#startTransfer").attr("disabled", "disabled");
}

$("#remove-all-files").click(function(){
  filer.removeAllFiles()
      .then(filer.FileSystemQuota)
      .then(function({usedBytes, grantedBytes}){
        var div1Content = "<div>Filesystem quota (used/total): " + getFileSize(usedBytes) + "/" + getFileSize(grantedBytes) + " (" + Math.floor(usedBytes/grantedBytes * 100) + "%)</div>";
        var div2Content = "<div style='color: #757575; font-size: 12px;'>Please make sure total size of received files doesn't exceed the total quota.</div>";
        $("#fileSystemQuota").html(div1Content + div2Content);
      })
      .catch(() => console.log("failed to remove some files"))
});

$("#peerListContainer").on('change', 'input:radio[name="peerList"]', function(){
  selectedPeerID = $(this).val();
});

$("#taskList").on('click', '.removeTask', function(e){
  filer.removeTask( $(e.target).data('fileid') )
});

function checkQuota(){
  if (!filer.isFileSystemAPIsupported) {
    $("#fileSystemQuota").text("Your browser doesn't support Filesystem API, please use Chrome.");
    return
  }

  filer.FileSystemQuota()
      .then(function({usedBytes, grantedBytes}){
        var div1Content = "<div>Filesystem quota (used/total): " + getFileSize(usedBytes) + "/" + getFileSize(grantedBytes) + " (" + Math.floor(usedBytes/grantedBytes * 100) + "%)</div>";
        var div2Content = "<div style='color: #757575; font-size: 12px;'>Please make sure total size of received files doesn't exceed the total quota.</div>";
        $("#fileSystemQuota").html(div1Content + div2Content);
      })
      .catch(err => console.log("err checking quota: ", err));
}
checkQuota();

function addTask(task){
  var tbody = $('#taskList').find('tbody');
  var fileName = "<td id='fileName-" + task.fileID + "'>" + task.fileName + "</td>";
  var progress = "<td id='progress-" + task.fileID + "'>" + (Math.floor(task.progress * 100)) + "%</td>";
  var fileSize = "<td>" + getFileSize(task.fileSize) + "</td>";
  var fileFrom = myID == task.from ? 'me' : task.from;
  fileFrom = "<td>" + fileFrom + "</td>";
  var fileTo = myID == task.to ? 'me' : task.to;
  fileTo = "<td>" + fileTo + "</td>";
  var fileStatus = "<td id='status-" + task.fileID + "'>" + task.status + "</td>";
  var fileButton = "<td><button type='button' data-fileid='" + task.fileID + "' class='btn btn-primary removeTask'>remove</button></td>";
  tbody.append($("<tr>" + fileName + progress + fileSize + fileFrom + fileTo + fileStatus + fileButton + "</tr>"))
}

// todo: if currently selected peer goes offline, selectedPeerID should be set to null
function addPeers(peers){
  var peersDIV = '';
  peers.forEach(p => {
    peersDIV += `<div class='radio'>
                    <label>
                      <input type="radio" name="peerList" id="${p}" value="${p}">
                      ${p}
                    </label>
                  </div>`
  });
  $('#peerListContainer').append(peersDIV)
}

// todo: if the currently selected peer is removed, disable the 'start transfer' button
function removePeer(peer){
  console.log('removing: ', peer);
  $('#' + peer).closest("div.radio").remove()
}

var ws = new WebSocket('ws://127.0.0.1:8000');
ws.onopen = evt => {
  filer.signalingChannel = ws;
  console.log('webSocket connected');
};

ws.onmessage = msg => {
  try {
    var msgObj = JSON.parse(msg.data);
  } catch (e){
    console.log('Oops, unknown msg: ', e);
    return
  }
  console.log('new msg from ws server: ', msgObj);
  switch (msgObj.msgType) {
    case "newUser":
      users[ msgObj.userID ] = true;
      addPeers([msgObj.userID]);
      console.log('new comer: ', msgObj.userID);
      break;

    case "removeUser":
      delete users[ msgObj.userID ];
      removePeer(msgObj.userID);
      console.log('remove user: ', msgObj.userID);
      break;

    case "profile":
      msgObj.peersID.forEach(p => users[p] = true);
      console.log('profile: my uid: ', msgObj.userID, ', peersID: ', msgObj.peersID);
      filer.myID = myID = msgObj.userID;
      addPeers(msgObj.peersID);
      $('#myID').text('my ID: ' + msgObj.userID);
      break;

    case "signaling":
      filer.handleSignaling(msgObj);
      break;

    default: console.log('Oops. unknown msg: ', msgObj)
  }
};

function getFileSize(bytes, si) {
  var thresh = si ? 1000 : 1024;
  if(Math.abs(bytes) < thresh) {
    return bytes + ' B';
  }
  var units = si
      ? ['kB','MB','GB','TB','PB','EB','ZB','YB']
      : ['KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB'];
  var u = -1;
  do {
    bytes /= thresh;
    ++u;
  } while(Math.abs(bytes) >= thresh && u < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[u];
}
