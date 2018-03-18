let chokidar = require('chokidar');
let SSH2 = require('ssh2');
let conn = new SSH2.Client();
let fs = require('fs');

let sshConfig = JSON.parse(fs.readFileSync('./ssh.config.json'));
let sftpConfig = {
	"host": sshConfig.host,
	"username": sshConfig.username,
	"password": sshConfig.password,
	"port": sshConfig.port,
	"tryKeyboard": true,
	// "debug": console.log
}

let queue = []
let queueIsRunning = false
let sftp = null

console.log('\033[2J');

conn.on('ready',
function() {
  console.log('Client :: ready');
  conn.sftp(function(err, client) {
		sftp = client
    if (err) throw err;

			// chokidar.watch(sshConfig.localViewsFolderPath,{
			// 	ignoreInitial: true,
			// }).on('all', (event, path) => {
				// console.log(event, path)

				// console.log(sftp);
				let path = '../Pure.MVC/Views/test/'
				let event = 'unlinkDir'
				let remotePath = sshConfig.remoteViewsFolderPath + path.replace(sshConfig.localViewsFolderPath, '')
				// console.log(sftp.get(remotePath));
				queue.push({
					"event": event,
					"path": path,
					"remotePath": remotePath
				});

				if(!queueIsRunning){
					queueIsRunning = true
					RunQueue(function* () {
						for (var i = queue.length - 1; i > -1; i--) {
							yield queue[i]
						}
					});
				}



			// });
  });
}).on('error',
	err => console.log('ERROR ', err)
).on('end',
	err => console.log('ENDED')
).on('close',
	hadError => console.log('HADERROR ', hadError)
).connect(sftpConfig)





function CreateRemoteDirs(generator){
	var gnFn = generator.apply(this, arguments);

	function handle(yeildVal) {
		console.log(yeildVal);
		sftp.readdir(yeildVal.value, (err) => {
			console.log('dwaiuhwaiuh');
			if(err) {
				sftp.mkdir(yeildVal.value, function(err, list) {
					if (err) throw err;
					gnFn.next();
				});
			}
			else {
				gnFn.next();
			}
		})
	}

	try {
		return handle(gnFn.next());
	} catch (ex) {
		return Promise.reject(ex);
	}
}



function DeleteRemoteFiles(path){
	console.log(path);
	sftp.readdir(path, (err, list) => {

		console.log(list);
		for (var i = 0; i < list.length; i++) {
			if(list[i].filename.indexOf('.') === -1){
				DeleteRemoteFiles(path + '/' +list[i].filename);
			}
			else {
				sftp.unlink(path + '/' +list[i].filename, function(err) {
					if (err) throw err;
				});
			}
		}
		// if(err) {
		// 	sftp.mkdir(yeildVal.value, function(err, list) {
		// 		if (err) throw err;
		// 		gnFn.next();
		// 	});
		// }
		// else {
		// 	gnFn.next();
		// }
	})

}


function RunQueue(generator) {
	var gnFn = generator.apply(this, arguments);

	function handle(result){
		console.log('result', result);
		if (result.done) return Promise.resolve(result.value);


				if(result.value.event === 'add' || result.value.event === 'addDir'){
					let foldersInPath = result.value.remotePath.replace(sshConfig.remoteViewsFolderPath, '').split('/').slice(0, -1);
					console.log(foldersInPath);
					CreateRemoteDirs(function* (){
						let path = sshConfig.remoteViewsFolderPath.substr(sshConfig.remoteViewsFolderPath.length - 1) === '/' ?
							sshConfig.remoteViewsFolderPath.slice(0,-1) :
								sshConfig.remoteViewsFolderPath;

						for (var i = 0; i < foldersInPath.length; i++) {
							path += '/' + foldersInPath[i];
							yield path
						}
					})

					DoFileAction(result.value.remotePath)
					.then(
						() => {
							// queue.pop();
							handle(gnFn.next())
						},
						(err) => {
							console.log('DoFileAction', err);
							handle(gnFn.throw(err))
						}
					)
				} else if (result.value.event === 'unlinkDir') {
					DeleteRemoteFiles(result.value.remotePath);
				}



		// return sftpGet.then(function (res){
		// 	console.log('res', res);
		// 	// return handle(gnFn.next(res));
		// }, function (err){
		// 	return handle(gnFn.throw(err));
		// });
	}

	try {
		return handle(gnFn.next());
	} catch (ex) {
		return Promise.reject(ex);
	}
}





function DoFileAction(file){
	console.log('file.event', file.event);
	switch (file.event) {
		case 'unlink':
			return new Promise((resolve, reject) => {
				sftp.unlink(file.remotePath, (err) => {
					if(err){
						reject(err)
					}
					else {
						resolve();
					}
				})
			})
			break;
		case 'unlinkDir':
			return new Promise((resolve, reject) => {
				sftp.rmdir(file.remotePath, (err) => {
					console.log('unlinkDir', err);
					if(err){
						reject(err)
					}
					else {
						resolve();
					}
				})
			})
			break;
		case 'add':
			return new Promise((resolve, reject) => {
				sftp.fastPut(file.path, file.remotePath, {}, (err) => {
				console.log('add err ', err);
					if(err){
						reject(err)
					}
					else {
						resolve();
					}
				})
			})
			break;
		case 'addDir':
			return new Promise((resolve, reject) => {
				sftp.mkdir(file.remotePath, (err) => {
					if(err){
						reject(err)
					}
					else {
						resolve();
					}
				})
			})
			break;
	}


}


// var Client = require('ssh2').Client;
//
// var connn = new Client();
// connn.on('ready', function() {
//   console.log('Client :: ready');
//   connn.sftp(function(err, sftp) {
//     // if (err) throw err;
// 		console.log(err);
// 		console.log(sshConfig.remoteViewsFolderPath);
// 		// console.log(remotePath);
//     sftp.mkdir('/C:/Projekt/pureweb-ssh/Pure.MVC/Views/test', function(err, list) {
//       // if (err) throw err;
// 			console.log(err);
// 			// if (list) {
// 			// 	console.dir(list);
// 			// 	// connn.end();
// 			// }
//     });
//   });
// }).connect({
// 	"host": sshConfig.host,
// 	"username": sshConfig.username,
// 	"password": sshConfig.password,
// 	"port": sshConfig.port,
// 	"tryKeyboard": true,
// 	"debug": console.log
// });
