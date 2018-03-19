const chokidar = require('chokidar');
const SSH2 = require('ssh2');
const conn = new SSH2.Client();
const fs = require('fs');
const { exec } = require('child_process');

const SSH_CONFIG = JSON.parse(fs.readFileSync('./ssh.config.json'));
const SFTP_CONFIG = {
	'host': SSH_CONFIG.host,
	'username': SSH_CONFIG.username,
	'password': SSH_CONFIG.password,
	'port': SSH_CONFIG.port,
	'tryKeyboard': true,
	// "debug": console.log
}

let QUEUE = []
let SFTP = null
let IS_RUNNING_QUEUE = false

function LOG(identity, data){
	if(SSH_CONFIG.log){
		console.log('LOG: ' + identity, (data ? data : ''));
	}
}

async function ReadDir(path){
	return new Promise((resolve, reject) => {
		SFTP.readdir(path, (err, list) => {
			if (err) reject()
			resolve({'path': path, 'list': list})
		})
	})
}

async function CheckDirExists(path){
	return new Promise((resolve, reject) => {
		SFTP.readdir(path, (err, list) => {
			if (err) reject()
			resolve()
		})
	})
}

async function CheckFileExists(path){
	return new Promise((resolve, reject) => {
		SFTP.stat(path, (err, list) => {
			if (err) reject()
			resolve()
		})
	})
}

async function Unlink(path){
	return new Promise((resolve, reject) => {
		CheckFileExists(path)
			.then(() => {
				SFTP.unlink(path, (err) => {
					// if (err) throw err;
					resolve()
				})
			})
			.catch(() => resolve())
	})
}


async function Rmdir(path){
	return new Promise((resolve, reject) => {
		CheckDirExists(path)
			.then(() => {
				SFTP.rmdir(path, (err) => {
					LOG('rmdir err ', err);
					resolve()
				})
			})
			.catch(() => resolve())
	})
}


async function Put(localPath, remotePath){
	return new Promise((resolve, reject) => {
		CheckFileExists(remotePath)
			.then(() => resolve())
			.catch(() => {
				SFTP.fastPut(localPath, remotePath, {}, (err) => {
					LOG('add err ', err);
					resolve();
				})
			})
	})
}

async function Mkdir(path) {
	return new Promise((resolve, reject) => {
		CheckDirExists(path)
			.then(() => resolve())
			.catch(() => {
				SFTP.mkdir(path, (err) => {
					LOG('mkdir err ', err);
					resolve();
				})
			})
	})
}


function CreateRemoteDirs(generator){
	let gnFn = generator.apply(this, arguments);

	function handle(yieldVal) {
		LOG('yieldVal', yieldVal);
		CheckDirExists(yieldVal.value)
			.then(() => gnFn.next())
			.catch(() => Mkdir(yieldVal.value)
				.then(() => gnFn.next())
			)
	}

	// try {
		return handle(gnFn.next());
	// } catch (ex) {
	// 	return Promise.reject(ex);
	// }
}



function DeleteRemoteFiles(startPath){
	let SubFolders = [];

	return new Promise((resolve1, reject1) => {
		function RunList({path, list}){
			// console.log('list', list);
			return new Promise((resolve2, reject2) => {
				let folders = [];
				// console.log('list', list);
				for (let i = 0; i < list.length; i++) {
					if(list[i].filename.indexOf('.') === -1){
						// console.log('found folder '+path + '/' +list[i].filename+', do check it out');
						SubFolders.push(path + '/' +list[i].filename);
						folders.push(
							new Promise((resolve3, reject3) => {
								ReadDir(path + '/' +list[i].filename)
									.then(res => RunList(res).then(() => {
										// console.log('resolve3', path + '/' +list[i].filename)
										resolve3()
									}))
									.catch(res => resolve3())
							})
						)
					}
					else {
						// console.log('found file '+path + '/' +list[i].filename+', remove it');
						Unlink(path + '/' +list[i].filename).then(() => true)
					}
				}

				// console.log('folders', folders);
				if(!folders.length){
					// console.log('resolve2', 'empty-folder')
					resolve2();
				}
				else {
					Promise.all(folders).then(() => {
						// console.log('resolve2', folders)
						resolve2();
					})
				}
			})
		}

		ReadDir(startPath)
			.then(res => RunList(res).then(() => {
				LOG('DELETING FOLDERS');
				LOG(SubFolders);
				let SubFolderPromises = [];
				SubFolders.sort((a, b) => {
					aSlashes = a.split('/').length;
					bSlashes = b.split('/').length;

					if ( bSlashes > aSlashes ) { return  1; }
			    if ( aSlashes > bSlashes ) { return -1; }
			    return 0;
				})
				.push(startPath)

				Promise.all(
					SubFolders.map(path => new Promise((res, rej) => Rmdir(path).then(() => res()) ))
				).then(() => resolve1())
			}))
			.catch(res => resolve1())

	});
}



function DoEvent({event, path, remotePath}) {
	return new Promise((resolve, reject) => {
		if(event === 'add' || event === 'addDir'){
			let foldersInPath = remotePath.replace(SSH_CONFIG.remoteViewsFolderPath, '').split('/')
			foldersInPath = foldersInPath.length === 1 ? foldersInPath : foldersInPath.slice(0, -1)
			LOG('foldersInPath', foldersInPath);
			CreateRemoteDirs(function* (){
				let path = SSH_CONFIG.remoteViewsFolderPath.substr(SSH_CONFIG.remoteViewsFolderPath.length - 1) === '/' ?
					SSH_CONFIG.remoteViewsFolderPath.slice(0,-1) :
						SSH_CONFIG.remoteViewsFolderPath;

				for (let i = 0; i < foldersInPath.length; i++) {
					path += '/' + foldersInPath[i];
					yield path
				}
			})

			if(event === 'add'){
				LOG('DO PUT');
				Put(path, remotePath).then(() => {
					LOG('NEXT PUT');
					resolve();
				})
			} else {
				LOG('DO MKDIR');
				CheckDirExists(remotePath)
					.then(() => {
						LOG('DIR EXISTS -> NEXT MKDIR');
						resolve();
					})
					.catch(res => Mkdir(remotePath)
						.then(() => {
							resolve();
						})
					)
			}

		} else if (event === 'unlinkDir') {
			LOG('DO DELETE UNLINKDIR');
			DeleteRemoteFiles(remotePath).then(() => {
				LOG('DONE DELETING FOLDER');
				resolve();
			});
		} else if (event === 'unlink') {
			LOG('DO DELETE UNLINK');
			Unlink(remotePath).then(() => {
				LOG('DONE DELETING FILE');
				resolve();
			});
		}
	})
}


function RunQueue(generator) {
	return new Promise(function(resolve, reject) {
		var gnFn = generator.apply(this,arguments);

		function handle(res){
			console.log('res', res)
			let clone = {...res}
			if(res.done) resolve()

			DoEvent({
				'event': clone.value.event,
				'path': clone.value.path,
				'remotePath': clone.value.remotePath
			})
			.then(() => {
				console.log('DONE ' + clone.value.event + ': ', clone.value.path.slice(3))
				console.log('gnFn.done', gnFn.done);
				handle(gnFn.next())
			})
		}
		handle(gnFn.next())
	});
}

function CheckQueue () {
	RunQueue(function* (){
		while(QUEUE.length){
			LOG('QUEUE.length', QUEUE.length)
			LOG('QUEUE ITEM', QUEUE[QUEUE.length - 1])
			yield QUEUE[QUEUE.length - 1]
			QUEUE.pop();
		}
	})
	.then(() => {
		LOG('CheckQueue AGAIN')
		LOG('QUEUE', QUEUE)
		if(QUEUE.length){
			CheckQueue()
		} else {
			IS_RUNNING_QUEUE = false;
		}
	})
}

console.log('\033[2J');
conn.on('ready',
	() => {
	  console.log('Client :: ready');

		let query = 'cd ' + SSH_CONFIG.remoteViewsFolderPath.slice(1).replace(/\//g, '\\') + ' && git branch';
		console.log(query);

		conn.sftp(function(err, client) {
			SFTP = client
			if (err) throw err;


			conn.exec(query, function exec(err, stream) {
				if (err) throw err;

				stream.on('close', function close(code, signal) {
					// console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
					// conn.end();
				});

				stream.on('data', function out(data) {
					// console.log('STDOUT: ' + data);
					let dataStr = '' + data;
					let remoteBranch = dataStr.split('\n').find(str => str.indexOf('*') !== -1).slice(2)

					console.log(remoteBranch);

					// chokidar.watch(SSH_CONFIG.localViewsFolderPath,{
					// 	ignoreInitial: true,
					// 	ignored: (SSH_CONFIG.regexFileIgnore ? SSH_CONFIG.regexFileIgnore : '')
					// }).on('all', (event, path) => {
					// 	// console.log(event, path)
					//
					// 	let remotePath = SSH_CONFIG.remoteViewsFolderPath + path.replace(SSH_CONFIG.localViewsFolderPath, '')
					//
					// 	RunQueue({
					// 		'event': event,
					// 		'path': path,
					// 		'remotePath': remotePath
					// 	}).then(() => console.log('DONE ' + event + ': ', path.slice(3)))
					// });
				});

				stream.stderr.on('data', function err(data) {
					console.log('STDERR: ' + data);
				});
		 	});


			chokidar.watch(SSH_CONFIG.localViewsFolderPath,{
				ignoreInitial: true,
				ignored: (SSH_CONFIG.regexFileIgnore ? SSH_CONFIG.regexFileIgnore : '')
			}).on('all', (event, path) => {
				// console.log(event, path)
				let remotePath = SSH_CONFIG.remoteViewsFolderPath + path.replace(SSH_CONFIG.localViewsFolderPath, '')
				QUEUE.push({
					'event': event,
					'path': path,
					'remotePath': remotePath
				})

				if(!IS_RUNNING_QUEUE){
					IS_RUNNING_QUEUE = true;
					CheckQueue()
				}

			});

		});
	}
).on('error',
	err => console.log('ERROR ', err)
).on('end',
	err => console.log('ENDED')
).on('close',
	hadError => console.log('HADERROR ', hadError)
).connect(SFTP_CONFIG)
