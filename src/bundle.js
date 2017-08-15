var Filer = require('simple-filer');
var filer = new Filer({}); // 必须页面一载入, 就new Filer(), 而不是点击发送按钮的一刻, new Filer(), 这样的话, 等于每发一个文件, 新建一个filer obj, 没有充分利用***

filer.on('newTask', function(task) {
  addTask(task);
});

filer.on('newProgress', function({fileID, progress, fileName, fileURL}){
  var progressTD = $("#progress-" + fileID);
  progressTD.text(Math.floor(progress * 100) + '%');
  if (progress === 1 && fileURL){
    var fileNameTD = $("#fileName-" + fileID);
    fileNameTD.html("<a href='" + fileURL + "' download>" + fileName + "</a>")
  }
});

filer.on('newStatus', function({fileID, status}){
  console.log('new status: ', fileID, '/', status);
  var statusTD = $("#status-" + fileID);
  statusTD.text(status);
  if (status == 'done' || status == 'removed') checkQuota()
});

var myID, selectedPeerID, users = {};
var ws = new WebSocket('wss://192.168.0.199:8443'); // todo 不能写成这样啊， 用localhost吧
// ws作为参数传给filer的ctor时候，check一下是否 wss， 因为不支持ws
var file; // tile to be sent
$("#inputFile").change(function(e){
  file = e.target.files[0];
});

$("#startTransfer").click(function(){ // if no peer selected, disable this button.
  console.log('uid: ', selectedPeerID, ' is selected');
  filer.myID = myID;
  filer.signalingChannel = ws;
  //filer.createPeerConnection(myID, selectedPeerID, true, ws); // myID作为ctor参数预先获取，createPeer的时候就无需这个参数了。
  filer.send(selectedPeerID, file)
});

// get currently selected peerID
// with checkbox/radio buttons, use 'change' event
$("#peerListContainer").on('change', 'input:radio[name="peerList"]', function(){
  selectedPeerID = $(this).val();
});

$("#taskList").on('click', '.removeTask', function(e){
  filer.removeTask( $(e.target).data('fileid') )
});

checkQuota();
function checkQuota(){ // https://developer.chrome.com/apps/offline_storage
  navigator.webkitTemporaryStorage.queryUsageAndQuota (
      function(usedBytes, grantedBytes){
        $("#fileSystemQuota").text("Filesystem quota (used/total): " + getFileSize(usedBytes) + "/" + getFileSize(grantedBytes) + " (" + Math.floor(usedBytes/grantedBytes * 100) + "%)");
      },
      function(err){
        console.log('Error querying temporary storage: ', err)
      }
  );
}

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

// if currently selected peer goes offline, selectedPeerID should be set to null
// add peer(s) to peerList
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

function removePeer(peer){ // todo check whether the currently selected peer is removed, if so, disable the 'start transfer' button
  console.log('removing: ', peer);
  $('#' + peer).closest("div.radio").remove()
}

ws.onmessage = msg => {
  try{
    var msgObj = JSON.parse(msg.data);
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
        myID = msgObj.userID;
        addPeers(msgObj.peersID);
        $('#myID').text('my ID: ' + msgObj.userID);
        break;
      case "signaling":
        filer.myID = myID;
        filer.signalingChannel = ws;
        filer.handleSignaling(msgObj);
        break;
      default: console.log('Oops. unknown msg: ', msgObj)
    }
  } catch (e){
    console.log('Oops, unknown msg: ', e)
  }
  //console.log('current users: ', users)
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
    return bytes.toFixed(1)+' '+units[u];
}
