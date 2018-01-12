import * as log from './util/log';
import * as fs from './util/fs';
import * as work from './util/work';
import * as f from './util/filesystem';
import * as util from './util/util';
import * as vsutil from './vsutil';
import * as ftp from './ftp';
import * as cfg from './config';
import stripJsonComments = require('strip-json-comments');

const config = cfg.config;

export interface BatchOptions
{
	doNotRefresh?:boolean;
	doNotMakeDirectory?:boolean;
	ignoreNotExistFile?:boolean;
}

function testLatest(file:f.State|null, localStat:fs.Stats):boolean
{
    if (!file) return false;
    switch(file.type)
    {
    case "-":
        if (!localStat.isFile()) return false;
		if (file instanceof f.FileCommon)
		{
    		if (localStat.size !== file.size) return false;
		}
        break;
    case "d":
        if (!localStat.isDirectory()) return false;
        break;
    case "l":
        if (!localStat.isSymbolicLink()) return false;
        break;
    }
    return true;
}

async function _getUpdatedFileInDir(cmp:f.Directory|null, path:string, list:{[key:string]:fs.Stats}):Promise<void>
{
	const files = await fs.list(path);
    for (const filename of files)
	{
        var filepath = path + "/" + filename;
        var childfile:f.State|null = null;
		if (cmp)
		{
			const file = cmp.files[filename];
			if (file) childfile = file;
		}
        await _getUpdatedFile(childfile, filepath, list);
	}
}

async function _getUpdatedFile(cmp:f.State|null, path:string, list:{[key:string]:fs.Stats}):Promise<void>
{
    if (cfg.checkIgnorePath(path)) return;
	try
	{
		const st = await fs.lstat(path);
		if (st.isDirectory()) await _getUpdatedFileInDir(cmp instanceof f.Directory ? cmp : null, path, list);
		if (testLatest(cmp, st)) return;
		list[path] = st;
	}
	catch(err)
	{
	}
}

class RefreshedData extends util.Deferred<f.Directory>
{
	accessTime:number = new Date().valueOf();

	constructor()
	{
		super();
	}
}

export class UploadReport
{
	directoryIgnored:boolean = false;
	latestIgnored:boolean = false;
	noFileIgnored:boolean = false;
	file:f.State | null = null;
}

class FtpFileSystem extends f.FileSystem
{
	refreshed:Map<string, RefreshedData> = new Map;

	_deletedir(dir:f.Directory, path:string):void
	{
		if (!this.refreshed.delete(path)) return;
		for(const filename in dir.files)
		{
			const childdir = dir.files[filename];
			if (!(childdir instanceof f.Directory)) continue;
			this._deletedir(childdir, path+'/'+filename);
		}
	}

	delete(path:string):void
	{
		const dir = this.get(path);
		if (dir) this._deletedir(dir, path);
		super.delete(path);
	}
	
	async ftpDelete(task:work.Task, path:string, options?:BatchOptions):Promise<void>
	{
		const that = this;

		async function deleteTest(file:f.State):Promise<void>
		{
			if (file instanceof f.Directory) await ftp.rmdir(task, path);
			else await ftp.remove(task, path);
			that.delete(path);
		}

		var file:f.State|null = this.get(path);
		if (file !== null)
		{
			try
			{
				return await deleteTest(file);
			}
			catch(err)
			{
			}
		}
		file = await that.ftpStat(task, path, options);
		if (file === null) return;
		await deleteTest(file);
	}

	async ftpUpload(task:work.Task, path:string, options?:BatchOptions):Promise<UploadReport>
	{
		const report = new UploadReport;
	
		const that = this;
		var stats:fs.Stats;
		var oldfile:f.State|undefined = undefined;
		
		try
		{
			stats = await fs.stat(path);
		}
		catch(e)
		{
			if (e.code === 'ENOENT' && options && options.ignoreNotExistFile)
			{
				report.noFileIgnored = true;
				return report;
			}
			throw e;
		}
		
		async function next():Promise<UploadReport>
		{
			if (stats.isDirectory())
			{
				if (options && options.doNotMakeDirectory)
				{
					report.directoryIgnored = true;
					return report;
				}

				if (oldfile)
				{
					if (oldfile instanceof f.Directory)
					{
						oldfile.lmtimeWithThreshold = oldfile.lmtime = +stats.mtime;
						report.file = oldfile;
						return report;
					}
					await that.ftpDelete(task, path).then(() => ftp.mkdir(task, path));
				}
				else
				{
					await ftp.mkdir(task, path);
				}

				const dir = that.mkdir(path);
				dir.lmtimeWithThreshold = dir.lmtime = +stats.mtime;
				report.file = dir;
				return report;
			}
			else
			{
				that.refreshed.delete(path);
				const fn = f.splitFileName(path);
				that.refreshed.delete(fn.dir);
				try
				{
					await ftp.upload(task, path, fs.workspace + path);
				}
				catch(e)
				{
					if (e.code === 'ENOENT' && options && options.ignoreNotExistFile)
					{
						report.noFileIgnored = true;
						return report;
					}
					throw e;
				}

				const file = that.create(path);
				file.lmtimeWithThreshold = file.lmtime = +stats.mtime;
				file.size = stats.size;
				report.file = file;
				return report;
			}
		}

		const fn = f.splitFileName(path);
		const filedir = this.get(fn.dir);
		if (!filedir) return await next();
		oldfile = filedir.files[fn.name];
		if (!oldfile) return await next();
		if (+stats.mtime <= oldfile.lmtimeWithThreshold)
		{
			report.latestIgnored = true;
			report.file = oldfile;
			return report;
		}
		if (+stats.mtime === oldfile.lmtime)
		{
			report.latestIgnored = true;
			report.file = oldfile;
			return report;
		}
		if (!config.autoDownload) return await next();

		const oldtype = oldfile.type;
		const oldsize = oldfile.size;
		const ftpstats = await this.ftpStat(task, path, options);

		if (ftpstats.type == oldtype &&  oldsize === ftpstats.size) return await next();

		const selected = await vsutil.errorConfirm(`${path}: Remote file modified detected.`, "Upload anyway", "Download");
		if (selected)
		{
			if (selected !== "Download") return await next();
			await this.ftpDownload(task, path);
		}
		report.file = oldfile;
		return report;
	}

	async ftpDownload(task:work.Task, path:string, options?:BatchOptions):Promise<void>
	{
		var file:f.State|null = this.get(path);
		if (!file)
		{
			file = await this.ftpStat(task, path, options);
			if (!file)
			{
				vsutil.error(`${path} not found in remote`);
				return Promise.resolve();
			}
		}

		if (file instanceof f.Directory) await fs.mkdir(path);
		else await ftp.download(task, fs.workspace + path, path);
		const stats = await fs.stat(path);
		file.lmtime = +stats.mtime;
		file.lmtimeWithThreshold = file.lmtime + 1000;
	}

	async ftpDownloadWithCheck(task:work.Task, path:string):Promise<void>
	{
		try
		{
			var stats = await fs.stat(path);
		}
		catch(e)
		{
			if (e.code === 'ENOENT') return; // vscode open "%s.git" file, why?
			throw e;
		}
		const file = await this.ftpStat(task, path);
		if (!file)
		{
			if (config.autoUpload)
			{
				await this.ftpUpload(task, path);
			}
			return;
		}

		if (file instanceof f.File && stats.size === file.size) return;
		if (file instanceof f.Directory) await fs.mkdir(path);
		else await ftp.download(task, fs.workspace + path, path);
		stats = await fs.stat(path);
		file.lmtime = +stats.mtime;
		file.lmtimeWithThreshold = file.lmtime + 1000;
	}

	async ftpStat(task:work.Task, path:string, options?:BatchOptions):Promise<f.State>
	{
		const fn = f.splitFileName(path);
		const dir = await this.ftpList(task, fn.dir, options);
		return dir.files[fn.name];
	}

	async init(task:work.Task):Promise<void>
	{
		try
		{
			await this.ftpList(task, '');
		}
		catch(e)
		{
			if (e.ftpError !== ftp.DIRECTORY_NOT_FOUND) 
			{
				throw e;
			}
			// ftp.list function suppress not found error
			// so..   these codes are useless
			const selected = await vsutil.errorConfirm(`remotePath(${config.remotePath}) does not exsisted", "Create Directory`);
			task.checkCanceled();
			if (!selected)
			{
				e.suppress = true;
				throw e;
			}
			await ftp.mkdir(task, '');
			task.checkCanceled();

			await this.ftpList(task, '');
		}
	}

	ftpList(task:work.Task, path:string, options?:BatchOptions):Promise<f.Directory>
	{
		const latest = this.refreshed.get(path);
		if (latest)
		{
			if (options && options.doNotRefresh) return latest;
			const refreshTime = config.autoDownloadRefreshTime ? config.autoDownloadRefreshTime : 1000;
			if (latest.accessTime + refreshTime > Date.now()) return latest;
		}
		const deferred = new RefreshedData;
		this.refreshed.set(path, deferred);

		return (async()=>{
			await ftp.init(task);

			try
			{
				const ftpfiles = await ftp.list(task, path);
				const dir = this.refresh(path, ftpfiles);
				deferred.resolve(dir);
				return dir;
			}
			catch(err)
			{
				deferred.catch(() => {});
				deferred.reject(err);
				if (this.refreshed.get(path) === deferred)
				{
					this.refreshed.delete(path);
				}
				throw err;
			}
		})();
	}

	syncTestUpload(task:work.Task, path:string):Promise<TaskList>
	{
		const output = {};
		const list = {};
		return _getUpdatedFile(this.root, path, list)
		.then(() => {
			let promise = Promise.resolve();
			for(const filepath in list)
			{
				const st = list[filepath];
				promise = promise
				.then(() => this.ftpStat(task, filepath))
				.then((file) => testLatest(file, st))
				.then((res) => { if(!res) output[filepath] = "upload"; });
			}
			return promise;
		})
		.then(() => output);
	}
		
	async _listNotExists(task:work.Task, path:string, list:TaskList, download:boolean):Promise<void>
	{
        if (cfg.checkIgnorePath(path)) return;
		const that = this;
		const command = download ? "download" : "delete"; 
		
		var fslist:string[];
		try
		{
			fslist = await fs.list(path);
		}
		catch (err)
		{
			if (!download) return;
			fslist = [];
		}

		try
		{
			const dir = await that.ftpList(task, path);
			const willDel:{[key:string]:boolean} = {};

			const dirlist:string[] = [];
			for(const p in dir.files)
			{
				const fullPath = path + "/" + p;
				if (cfg.checkIgnorePath(fullPath)) continue;

				switch(p)
				{
				case '': case '.': case '..': break;
				default:
					willDel[p] = true;
					if (dir.files[p] instanceof f.Directory)
					{
						dirlist.push(fullPath);
					}
					break;
				}
			}
			for(const file of fslist)
			{
				delete willDel[file];
			}

			function flushList():void
			{
				for (const p in willDel)
				{
					list[path + "/" + p] = command;
				}
			}
			async function processChild():Promise<void>
			{
				for(const child of dirlist)
				{
					await that._listNotExists(task, child, list, download);
				}
			}
			if (download)
			{
				flushList();
				await processChild();
			}
			else // delete
			{
				await processChild();
				flushList();
			}
		}
		catch(err)
		{
			throw err;
		}
	}

	syncTestNotExists(task:work.Task, path:string, download:boolean):Promise<TaskList>
	{
		const list:TaskList = {};
		return this._listNotExists(task, path, list, download)
		.then(() => list);
	}

	async _refeshForce(task:work.Task, path:string):Promise<void>
	{
		const dir = await this.ftpList(task, path);
		for(const p in dir.files)
		{
			switch(p)
			{
			case '': case '.': case '..': break;
			default:
				if (dir.files[p] instanceof f.Directory)
				{
					await this._refeshForce(task, path + "/" + p);
				}
				break;
			}
		}
	}
	
	ftpRefreshForce(task:work.Task):Promise<void>
	{
		this.refreshed.clear();
		return this._refeshForce(task, '');
	}
}

const vfs = new FtpFileSystem;
var syncDataPath = "";

export interface TaskList
{
	[key:string]:string;
}


export async function exec(task:work.Task, tasklist:TaskList, options?:BatchOptions):Promise<{tasks:TaskList, count:number}|null>
{
	var errorCount = 0;
	const failedTasks:TaskList = {};

	for (const file in tasklist)
	{
		const exec = tasklist[file];
		try
		{
			switch (exec)
			{
			case 'upload': await vfs.ftpUpload(task, file, options); break;
			case 'download': await vfs.ftpDownload(task, file, options); break;
			case 'delete': await vfs.ftpDelete(task, file, options); break;
			}
		}
		catch(err)
		{
			failedTasks[file] = exec;
			console.error(err);
			log.message(err);
			errorCount ++;
		}
	}
	if (errorCount)
		return {tasks:failedTasks, count:errorCount};
	else return null;
}

export function upload(task:work.Task, path:string, options?:BatchOptions):Promise<UploadReport>
{
	return vfs.ftpUpload(task, path, options);
}

export function download(task:work.Task, path:string, doNotRefresh?:boolean):Promise<void>
{
	return vfs.ftpDownload(task, path, {doNotRefresh});
}

export function downloadWithCheck(task:work.Task, path:string):Promise<void>
{
	return vfs.ftpDownloadWithCheck(task, path);
}

export function syncTestClean(task:work.Task):Promise<TaskList>
{
	return vfs.syncTestNotExists(task, "", false);
}

export function syncTestUpload(task:work.Task, path:string):Promise<TaskList>
{
	return vfs.syncTestUpload(task, path);
}

export function syncTestDownload(task:work.Task, path:string):Promise<TaskList>
{
	return vfs.syncTestNotExists(task, path, true);
}

export function saveSync():void
{
	if(!syncDataPath) return;
	if (cfg.state !== cfg.State.LOADED) return;
	if (!config.createSyncCache) return;
	fs.mkdir("/.vscode");
	return fs.createSync(syncDataPath, JSON.stringify(vfs.serialize(), null, 4));
}

export async function load():Promise<void>
{
	try
	{
		syncDataPath = `/.vscode/ftp-kr.sync.${config.protocol}.${config.host}.${config.remotePath.replace(/\//g, ".")}.json`;
	
		try
		{
			const data = await fs.open(syncDataPath);
			const obj = util.parseJson(data);
			if (obj.version === 1)
			{
				vfs.deserialize(obj);
			}
			vfs.refreshed.clear();
		}
		catch(err)
		{
			vfs.reset();
			vfs.refreshed.clear();
			if (err === work.CANCELLED) throw err;
		}
	}
	catch(nerr)
	{
		if (nerr === work.CANCELLED) throw nerr;
		vsutil.error(nerr);
	}
}

export function refreshForce(task:work.Task):Promise<void>
{
	return vfs.ftpRefreshForce(task);
}

export async function list(task:work.Task, path:string):Promise<void>
{
	const dir = await vfs.ftpList(task, path);
	const pick = new vsutil.QuickPick;
	for(const filename in dir.files)
	{
		switch(filename)
		{
		case '': case '.': continue;
		case '..':
			if(path === '') continue;
			pick.item('[DIR]\t..', ()=>list(task, path.substring(0, path.lastIndexOf('/'))));
			continue;
		}
		const file = dir.files[filename];
		const npath = path + '/' + filename;
		
		switch (file.type)
		{
		case '-':
			pick.item('[FILE]\t' + file.name, ()=>{
				pick.clear();
				pick.item('Download '+file.name, ()=>download(task, npath));
				pick.item('Upload '+file.name, ()=>upload(task, npath));
				pick.item('Delete '+file.name, ()=>remove(task, npath));
				pick.oncancel = ()=>list(task, path);
				pick.open();
			});
			break;
		case 'd':
			pick.item('[DIR]\t' + file.name, ()=>list(task, npath));
			break;
		}
	}
	pick.items.sort((a,b)=>a.label.localeCompare(b.label));
	pick.open();
}

export function init(task:work.Task):Promise<void>
{
	return vfs.init(task);
}

export function remove(task:work.Task, path:string):Promise<void>
{
	return vfs.ftpDelete(task, path);
}
