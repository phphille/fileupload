const __CHOKIDAR__ = require('chokidar');
const __SSH2__ = require('ssh2');
const __CONN__ = new __SSH2__.Client();
const __FS__ = require('fs');
const __EXEC__ = require('child_process').exec;
const __UTIL__ = require('util')
const __PROCESS__ = require('process');
const __CONFIRM__ = require('node-ask').confirm;
const __CHALK__ = require('chalk');
const __LOG_OK__ = __CHALK__.black.bgGreenBright.bold;
const __LOG_ERR__ = __CHALK__.white.bgRed.bold;
const __LOG_INFO__ = __CHALK__.white.bgBlue.bold;
const __LOG_DEBUG__ = __CHALK__.white.bgMagenta.bold;

const SSH_CONFIG = JSON.parse(__FS__.readFileSync('./ssh.config.json'));
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
		console.log(`LOG: ${identity}`, (data ? data : ''));
	}
}

function ECHO(identity, data){
	console.log(`${identity}`, (data ? data : ''));
}

__PROCESS__.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
});

async function RemoteTerminal(query, onDataFn) {
	return new Promise((resolve, reject) => {
		__CONN__.exec(query, (err, stream) => {
			if (err) throw err

			stream.stdout.on('data', (data) => {
				resolve(onDataFn(''+data));
			})

			stream.stderr.on('data', (data) => {
				ECHO(__LOG_ERR__('Command prompt err: '),  ''+data)
				reject()
			})

		})
	})
}

async function LocalTerminal(query, onDataFn) {
	return new Promise((resolve, reject) => {
		__EXEC__(query, {}, (error, stdout, stderr) => {
			if (error !== null) {
				ECHO(__LOG_ERR__('Check local branch error: '), '' + error);
				reject();
			} else {
				resolve(onDataFn(stdout));
			}
		})
	})
}

async function CheckRemoteRepo() {
	return new Promise((resolve, reject) => {
		let gitNameQuery = 'cd ' + SSH_CONFIG.remoteViewsFolderPath.slice(1).replace(/\//g, '\\') + ' && git config --get remote.origin.url'

		ECHO('Checking remote repo:', gitNameQuery);
		RemoteTerminal(gitNameQuery, data => data.trim().split('/').reverse()[0])
			.then((remoteRepo) => {
				ECHO('Remote repo is:', remoteRepo);
				resolve(remoteRepo)
			})
			.catch(() => reject())
	});
}

async function CheckRemoteBranch() {
	return new Promise((resolve, reject) => {
		let branchQuery = 'cd ' + SSH_CONFIG.remoteViewsFolderPath.slice(1).replace(/\//g, '\\') + ' && git branch'
		ECHO('Checking remote branch:', branchQuery);
		RemoteTerminal(branchQuery, (data) => ('' + data).split('\n').find(str => str.indexOf('*') !== -1).slice(2))
			.then(remoteBranch => resolve(remoteBranch))
			.catch(() => reject())
	});
}

async function CheckLocalRepo (){
	return new Promise((resolve, reject) => {
		ECHO('Checking local repo');
		LocalTerminal('git config --get remote.origin.url', (data) => data.trim().split('/').reverse()[0])
			.then(repoName => resolve(repoName))
			.catch(() => reject())
	});
}

async function CheckLocalBranch (){
	return new Promise((resolve, reject) => {
		ECHO('Checking local branch');
		LocalTerminal('git branch', (data) => ('' + data).split('\n').find(str => str.indexOf('*') !== -1).slice(2))
			.then(repoName => resolve(repoName))
			.catch(() => reject())
	});
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
			if (err) {
				LOG('FOLDER DOES NOT EXISTS')
				return reject()
			}
			LOG('FOLDER DOES EXISTS')
			return resolve()
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
					if(err){
						LOG('rmdir err', path)
						LOG('rmdir err', err)
						throw err
					}
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
					LOG('fastPut', [localPath, remotePath]);
					if(err){
						LOG('add err', err);
					}
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
					if(err){
						LOG('mkdir err', path)
						LOG('mkdir err', err)
					}
					resolve();
				})
			})
	})
}


function CreateRemote(generator){
	return new Promise(function(resolve, reject) {
		let gnFn = generator()

		function handle(yieldVal) {
			LOG('yieldVal', yieldVal)
			if(yieldVal.done) return resolve()

			if(yieldVal.value.isFile){
				Put(yieldVal.value.localPath, yieldVal.value.remotePath)
					.then(() => {
						return handle(gnFn.next())
					})
			} else {
				Mkdir(yieldVal.value.remotePath)
					.then(() => {
						return handle(gnFn.next())
					})
			}
		}

		handle(gnFn.next());
	});
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
			.then(res => RunList(res)
				.then(() => {
					LOG('DELETING FOLDERS')
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
			LOG('foldersInPath', foldersInPath);

			CreateRemote(function* (){
				let remtPath = SSH_CONFIG.remoteViewsFolderPath.substr(SSH_CONFIG.remoteViewsFolderPath.length - 1) === '/' ?
					SSH_CONFIG.remoteViewsFolderPath.slice(0,-1) :
						SSH_CONFIG.remoteViewsFolderPath

				let localPath = SSH_CONFIG.localViewsFolderPath.slice(0,-1)
				LOG('remtPath', remtPath);
				LOG('localPath', localPath);
				for (let i = 0; i < foldersInPath.length; i++) {
					remtPath += '/' + foldersInPath[i]
					localPath += '/' + foldersInPath[i]
					yield {'remotePath': remtPath, 'localPath': localPath, isFile: (foldersInPath[i].indexOf('.') !== -1)}
				}
			})
				.then(() => {
					resolve();
				})
				.catch(() => {})
		} else if (event === 'unlinkDir') {
			LOG('DO DELETE UNLINKDIR');
			DeleteRemoteFiles(remotePath)
				.then(() => {
					LOG('DONE DELETING FOLDER');
					resolve();
				});
		} else if (event === 'unlink') {
			LOG('DO DELETE UNLINK');
			Unlink(remotePath)
				.then(() => {
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
			let clone = {...res}
			if(res.done) return resolve()

			DoEvent({
				'event': clone.value.event,
				'path': clone.value.path,
				'remotePath': clone.value.remotePath
			})
				.then(() => {
					console.log('DONE ' + clone.value.event + ': ', clone.value.path.slice(3))
					handle(gnFn.next())
				})
		}
		handle(gnFn.next())
	});
}

function CheckQueue () {
	return new Promise((resolve, reject) => {
		RunQueue(function* (){
			while(QUEUE.length){
				LOG('QUEUE.length', QUEUE.length)
				LOG('QUEUE ITEM', QUEUE[0])
				yield QUEUE[0]
				QUEUE.shift();
			}
		})
			.then(() => {
				LOG('CheckQueue AGAIN')
				LOG('QUEUE', QUEUE)
				if(QUEUE.length){
					LOG('RUN QUEUE AGAIN')
					CheckQueue()
				} else {
					LOG('QUEUE IS EMPTY')
					IS_RUNNING_QUEUE = false
					resolve();
				}
			})
	});
}



function WatchFiles(dontUploadOnStart) {
	__CHOKIDAR__.watch(SSH_CONFIG.localViewsFolderPath,{
		ignoreInitial: dontUploadOnStart,
		ignored: (SSH_CONFIG.regexFileIgnore ? SSH_CONFIG.regexFileIgnore : '')
	})
	.on('ready', () => ECHO(__LOG_OK__('Ready for changes')))
	.on('all', (event, path) => {
		console.log(event, path)
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
}


console.log('\033[2J');
__CONN__.on('ready',() => {
  ECHO('Client :: ready');

	__CONN__.sftp(function(err, client) {
		SFTP = client
		if (err) throw err;

		Promise.all([CheckLocalRepo(), CheckRemoteRepo()])
			.then(resRepos => {
				if(resRepos.every( name => name === resRepos[0])){
					ECHO(__LOG_OK__('Repos are the same:'), resRepos[0])
					Promise.all([CheckLocalBranch(), CheckRemoteBranch()])
						.then(resBranches => {
							if(resBranches.every( name => name === resBranches[0])){
								ECHO(__LOG_OK__('Branches are the same:'), resBranches[0])
								__CONFIRM__(__LOG_INFO__('Do you want to sync local folder with remote folder before we start?(y/n)') + ' ')
									.catch(() => {console.log('catch');})
								  .then((cleanRemoteFolder) => {
										console.log(cleanRemoteFolder);
										if(cleanRemoteFolder){
											DeleteRemoteFiles(SSH_CONFIG.remoteViewsFolderPath)
												.then(() => {
													Mkdir(SSH_CONFIG.remoteViewsFolderPath)
														.then(() => {
															return WatchFiles(false)
														})
												})
												.catch()
										}
										else {
											SSH_CONFIG.uploadOnStart = true;
											return WatchFiles(true)
										}
								  })

							} else {
								ECHO(__LOG_ERR__('Branches are not the same'), resBranches);
								__PROCESS__.exit(1)
							}
						})
						.catch(() => {
							ECHO(__LOG_ERR__('Error checking branches'))
							__PROCESS__.exit(1)
						})
				} else {
					ECHO(__LOG_ERR__('Repos are not the same'), resRepos)
					__PROCESS__.exit(1)
				}
			})
			.catch(() => {
				ECHO(__LOG_ERR__('Error checking repos'))
				__PROCESS__.exit(1)
			})
	});
}).on('error',
	err => console.log(__LOG_ERR__('ERROR '), err)
).on('end',
	err => console.log(__LOG_ERR__('ENDED'))
).on('close',
	hadError => console.log(__LOG_ERR__('HADERROR '), hadError)
).connect(SFTP_CONFIG)
