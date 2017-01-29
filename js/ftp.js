
const FtpClient = require("ftp");
const SftpClient = require('ssh2-sftp-client');
const config = require('./config');
const util = require('./util');
const ofs = require('fs');
const iconv = require('iconv-lite');

const DIRECTORY_NOT_FOUND = 1;
const FILE_NOT_FOUND = 2;

var client = null;

function bin2str(bin)
{
    var buf = iconv.encode(bin, 'binary');
    return iconv.decode(buf, config.fileNameEncoding);
}
function str2bin(str)
{
    var buf = iconv.encode(str, config.fileNameEncoding);
    return iconv.decode(buf, 'binary');
}
function toftpPath(workpath)
{
    return str2bin(config.remotePath+workpath);
}

class FileInfo
{
	constructor()
	{
		/** @type {string} */
		this.type = '';
		/** @type {string} */
		this.name = '';
		/** @type {number} */
		this.size = 0;
		/** @type {number} */
		this.date = 0;
	}
}

class FileInterface
{
	constructor()
	{
		client = this;
		/** @type {number} */
		this.destroyTimeout = 0;
	}

	cancelDestroyTimeout()
	{
		if (this.destroyTimeout === 0)
			return;

		clearTimeout(this.destroyTimeout);
		this.destroyTimeout = 0;
	}
	update()
	{
		this.cancelDestroyTimeout();
		this.destroyTimeout = setTimeout(this.destroy.bind(this), 5000);
	}

	destroy()
	{
		this.cancelDestroyTimeout();
		client = null;
	}

	/**
	 * @param {string} name
	 * @param {string} workpath
	 * @param {number} ignorecode
	 * @param {function(string):!Promise} callback
	 * @return {!Promise}
	 */
	_callWithName(name, workpath, ignorecode, callback)
	{
		this.cancelDestroyTimeout();
		const that = this;
		util.setState(name +" "+workpath);
		util.log(name +": "+workpath);
		const ftppath = toftpPath(workpath);
		return callback(ftppath).then(()=>{
			util.setState("");
			that.update();
		})
		.catch((err)=>{
			util.setState("");
			that.update();
			if (err.ftpCode === ignorecode) return;
			util.log(name+" fail: "+workpath);
			throw _errorWrap(err);
		});
	}


	/**
	 * @param {string} workpath
	 * @param {string} localpath
	 * @returns {Promise}
	 */
	upload(workpath, localpath)
	{
		const that = this;
		this.cancelDestroyTimeout();
		util.setState("upload "+workpath);
		util.log("upload: "+workpath);
		const ftppath = toftpPath(workpath);

		return this._put(localpath, ftppath)
		.catch(err=>{
			if (err.ftpCode !== DIRECTORY_NOT_FOUND) throw err;
			const ftpdir = ftppath.substr(0, ftppath.lastIndexOf("/") + 1);
			if (!ftpdir) throw err;
			return that._mkdir(ftpdir, true)
			.then(()=>that._put(localpath, ftppath));
		})
		.then(()=>{
			util.setState("");
			that.update();
		})
		.catch((err)=>{
			util.setState("");
			that.update();
			util.log("upload fail: "+workpath);
			throw _errorWrap(err);
		});
	}

	/**
	 * @param {string} localpath
	 * @param {string} workpath
	 * @returns {!Promise}
	 */
	download(localpath, workpath)
	{
		this.cancelDestroyTimeout();
		util.setState("download "+workpath);
		util.log("download: "+workpath);
		const that = this;
		const ftppath = toftpPath(workpath);

		return this._get(ftppath)
		.then((stream)=>{
			return new Promise(resolve=>{
				stream.once('close', ()=>{
					util.setState("");
					that.update();
					resolve();
				});
				stream.pipe(ofs.createWriteStream(localpath));
			});
		})
		.catch(err=>{
			util.setState("");
			that.update();
			util.log("download fail: "+workpath);
			throw _errorWrap(err);
		});
	}

	/**
	 * @param {string} workpath
	 * @returns {!Promise}
	 */
	list(workpath)
	{
		this.cancelDestroyTimeout();
		util.setState("list "+workpath);
		util.log("list: "+workpath);

		const that = this;
		var ftppath = toftpPath(workpath);
		if (!ftppath) ftppath = ".";

		return this._list(ftppath).then((list)=>{
			util.setState("");
			that.update();
			const errfiles = [];
			for (var i = 0; i<list.length; i++)
			{
				const file = list[i];
				const fn = file.name = bin2str(file.name);
				if (!config.ignoreWrongFileEncoding)
				{
					if (fn.indexOf('�') !== -1 || fn.indexOf('?') !== -1)
						errfiles.push(fn);
				}
			}
			if (errfiles.length)
			{
				util.errorConfirm("Invalid encoding detected. Please set fileNameEncoding correctly\n"+errfiles.join('\n'), 'Open config', 'Ignore after')
				.then(function(res){
					switch(res)
					{
					case 'Open config': util.open(config.PATH); break; 
					case 'Ignore after': config.ignoreWrongFileEncoding = true; break;
					}
				});
			}
			return list;
		})
		.catch(err=>{
			util.setState("");
			that.update();
			util.log("list fail: "+workpath);
			throw _errorWrap(err);
		});
	}

	/**
	 * @param {string} workpath
	 * @returns {Promise}
	 */
	rmdir(workpath)
	{
		const that = this;
		return this._callWithName("rmdir", workpath, FILE_NOT_FOUND, ftppath=>that._rmdir(ftppath, true));
	}
	/**
	 * @param {string} workpath
	 * @returns {Promise}
	 */
	delete(workpath)
	{
		const that = this;
		return this._callWithName("delete", workpath, FILE_NOT_FOUND, ftppath=>that._delete(ftppath));
	}
	/**
	 * @param {string} workpath
	 * @returns {Promise}
	 */
	mkdir(workpath)
	{
		const that = this;
		return this._callWithName("mkdir", workpath, 0, ftppath=>that._mkdir(ftppath, true));
	}

	/**
	 * @param {string} path
	 * @param {boolean} recursive
	 * @return {!Promise}
	 * @abstract
	 */
	_mkdir(path, recursive)
	{
	}

	/**
	 * @param {string} path
	 * @param {boolean} recursive
	 * @return {!Promise}
	 * @abstract
	 */
	_rmdir(path, recursive)
	{
	}

	/**
	 * @param {string} workpath
	 * @returns {!Promise}
	 * @abstract
	 */
	_delete(workpath)
	{
	}

	/**
	 * @param {string} localpath
	 * @param {string} ftppath
	 * @return {!Promise}
	 * @abstract
	 */
	_put(localpath, ftppath)
	{
	}

	/**
	 * @param {string} ftppath
	 * @return {!Promise<!NodeJS.ReadableStream>}
	 * @abstract
	 */
	_get(ftppath)
	{
	}
	
	/**
	 * @param {string} ftppath
	 * @return {!Promise<!Array<!FileInfo>>}
	 * @abstract
	 */
	_list(ftppath)
	{
	}
}

class Ftp extends FileInterface
{
	constructor()
	{
		super();
		this.client = new FtpClient;
	}

	connect()
	{
		client = this;
		const that = this;
		return new Promise(function(resolve, reject){
			that.client.on("ready", function(){
				const socket = that.client._socket;
				const oldwrite = socket.write;
				socket.write = function(str){
					return oldwrite.call(socket, str, 'binary');
				};
				that.update();
				resolve();
			});
			that.client.on("error", function(e){
				reject(e);
				if (that.client)
				{
					that.client.end();
					that.client = null;
				}
				client = null;
			});
			that.client.connect({
				host: config.host,
				port: config.port ? config.port : 21, 
				user: config.username, 
				password: config.password
			});
		});
	}
	destroy()
	{
		super.destroy();
		if (this.client)
		{
			this.client.end();
			this.client = null;
		}
	}

	static wrapToPromise(callback)
	{
		return new Promise((resolve, reject)=>callback((err, val)=>{
			if(err) reject(err);
			else resolve(val);
		}));
	}

	/**
	 * @param {string} ftppath
	 * @param {boolean} recursive
	 * @return {!Promise}
	 */
	_rmdir(ftppath, recursive)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.rmdir(ftppath, recursive, callback))
		.catch(e=>{
			if (e.code === 550) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} ftppath
	 * @param {boolean} recursive
	 * @return {!Promise}
	 */
	_mkdir(ftppath, recursive)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.mkdir(ftppath, recursive, callback));
	}

	/**
	 * @param {string} ftppath
	 * @returns {!Promise}
	 */
	_delete(ftppath)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.delete(ftppath, callback))
		.catch(e=>{
			if (e.code === 550) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} localpath
	 * @param {string} ftppath
	 * @return {!Promise}
	 */
	_put(localpath, ftppath)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.put(localpath, ftppath, callback))
		.catch(e=>{
			if (e.code === 553) e.ftpCode = DIRECTORY_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} ftppath
	 * @return {!Promise<!NodeJS.ReadableStream>}
	 */
	_get(ftppath)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.get(ftppath, callback));
	}

	/**
	 * @param {string} ftppath
	 * @return {!Promise<!Array<!FileInfo>>}
	 */
	_list(ftppath)
	{
		const client = this.client;
		return Ftp.wrapToPromise(callback=>client.list(ftppath, false, callback))
		.then(list=>{
			for(var i=0;i<list.length;i++)
			{
				const from = list[i];
				const to = list[i] = new FileInfo;
				to.type = from.type;
				to.name = from.name;
				to.date = +from.date;
				to.size = +from.size;
			}
			return list;
		});
	}

}

class Sftp extends FileInterface
{
	constructor()
	{
		super();
		this.client = new SftpClient;
	}
	
	connect()
	{
		const that = this;
		return this.client.connect({
			host: config.host,
			port: config.port ? config.port : 22,
			user: config.username, 
			password: config.password
		})
		.then(()=>that.update())
		.catch(err=>{
			if (that.client)
			{
				that.client.end();
				that.client = null;
			}
			client = null;
			throw err;
		});
	}
	destroy()
	{
		super.destroy();
		if (this.client)
		{
			this.client.end();
			this.client = null;
		}
	}

	/**
	 * @param {string} ftppath
	 * @returns {Promise}
	 */
	_rmdir(ftppath)
	{
		return this.client.rmdir(ftppath, true)
		.catch(e=>{
			if (e.code === 2) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} ftppath
	 * @returns {Promise}
	 */
	_delete(ftppath)
	{
		return this.client.delete(ftppath)
		.catch(e=>{
			if (e.code === 2) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} ftppath
	 * @returns {Promise}
	 */
	_mkdir(ftppath)
	{
		return this.client.mkdir(ftppath, true);
	}

	/**
	 * @param {string} localpath
	 * @param {string} ftppath
	 * @return {!Promise}
	 */
	_put(localpath, ftppath)
	{
		return this.client.put(localpath, ftppath)
		.catch(e=>{
			if (e.code === 2) e.ftpCode = DIRECTORY_NOT_FOUND;
			throw e;
		});
	}

	/**
	 * @param {string} ftppath
	 * @return {!Promise<!NodeJS.ReadableStream>}
	 */
	_get(ftppath)
	{
		return this.client.get(ftppath);
	}

	/**
	 * @param {string} ftppath
	 * @return {!Promise<!Array<!FileInfo>>}
	 */
	_list(ftppath)
	{
		return this.client.list(ftppath)
		.then(list=>{
			for(var i=0;i<list.length;i++)
			{
				const from = list[i];
				const to = list[i] = new FileInfo;
				to.type = from.type;
				to.name = from.name;
				to.date = from.modifyTime;
				to.size = +from.size;
			}
			return list;
		}).catch(e=>{
			if (e.code === 2) return [];
			else throw e;
		});
	}

}

/**
 * @returns {!Promise}
 */
function init()
{
    if (client)
    {
        client.update();
        return Promise.resolve();
    }

	util.showLog();
	
	switch (config.protocol)
	{
	case 'sftp': new Sftp; break;
	case 'ftp': new Ftp; break;
	default:
		config.protocol = 'ftp';
		util.error(`Unsupported protocol "${config.protocol}", It will treat as ftp`);
		new Ftp;
		break;
	}
	var url = '';
	url += config.protocol;
	url += '://';
	url += config.host;
	if (config.port)
	{
		url += ':';
		url += config.port;
	}
	url += '/';
	url += config.remotePath;
	url += '/';

	util.log(`Try connect to ${url} with user ${config.username}`);

	return client.connect().then(()=>{
		util.log('Connected');
	});
}

function _errorWrap(err)
{
    return new Error(err.message +"["+err.code+"]");
}

module.exports = {
    /**
     * @param {string} workpath
     * @returns {!Promise}
     */
    rmdir(workpath)
    {
       return init().then(() => client.rmdir(workpath));
    },
    /**
     * @param {string} workpath
     * @returns {!Promise}
     */
    delete(workpath)
    {
       return init().then(() => client.delete(workpath));
    },
    /**
     * @param {string} workpath
     * @returns {!Promise}
     */
    mkdir(workpath)
    {
       return init().then(() => client.mkdir(workpath));
    },
    /**
     * @param {string} workpath
     * @param {string} localpath
     * @returns {!Promise}
     */
    upload(workpath, localpath)
    {
       return init().then(() => client.upload(workpath, localpath));
    },
    /**
     * @param {string} localpath
     * @param {string} workpath
     * @returns {!Promise}
     */
    download(localpath, workpath)
    {
       return init().then(() => client.download(localpath, workpath));
    },
    /**
     * @param {string} workpath
     * @returns {!Promise}
     */
    list(workpath)
    {
       return init().then(() => client.list(workpath));
    }
};