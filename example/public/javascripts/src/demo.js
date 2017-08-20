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
  if (status == 'done' || status == 'removed') checkQuota()
});

filer.on('error', function(err){ // you need to use switch/cases to take action on each type of errors
  console.log('err: ', err);
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

$("#peerListContainer").on('change', 'input:radio[name="peerList"]', function(){
  selectedPeerID = $(this).val();
});

$("#taskList").on('click', '.removeTask', function(e){
  filer.removeTask( $(e.target).data('fileid') )
});

function checkQuota(){
  navigator.webkitTemporaryStorage.queryUsageAndQuota (
      function(usedBytes, grantedBytes){
        $("#fileSystemQuota").text("Filesystem quota (used/total): " + getFileSize(usedBytes) + "/" + getFileSize(grantedBytes) + " (" + Math.floor(usedBytes/grantedBytes * 100) + "%)");
      },
      function(err){
        console.log('Error querying temporary storage: ', err)
      }
  );
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

//var ws = new WebSocket('wss://192.168.0.199:8443');
var ws = new WebSocket('wss://127.0.0.1:8443');
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
