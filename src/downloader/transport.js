/**
 * 文件下载模块
 *
 * @file src/downloader/Transport.js
 * @author mudio(job.zhanghao@gmail.com)
 */

import fs from 'fs';
import path from 'path';
import util from 'util';
import mkdirp from 'mkdirp';
import {EventEmitter} from 'events';
import {BosClient} from 'bce-sdk-js';
import debounce from 'lodash.debounce';
import throttle from 'lodash.throttle';

import {Meta, TransportStatus} from '../headers';

export default class Transport extends EventEmitter {
    constructor(credentials, config) {
        super();

        const {uuid, bucketName, objectKey, localPath} = config;

        this._uuid = uuid;
        this._objectKey = objectKey;
        this._localPath = localPath;
        this._bucketName = bucketName;
        this._client = new BosClient(credentials);

        this._state = TransportStatus.UnStarted;
    }

    /**
     * 获取Meta数据
     *
     * @returns {Promise}
     * @memberof MultiTransport
     */
    _fetchMetadata() {
        return this._client.getObjectMetadata(this._bucketName, this._objectKey).then((res) => {
            const xMetaSize = +res.http_headers['content-length'];
            const lastModified = new Date(res.http_headers['last-modified']);
            const xMetaMD5 = res.http_headers[Meta.xMetaMD5];
            const xMetaOrigin = res.http_headers[Meta.xMetaOrigin];

            const xMetaModifiedTime = lastModified.getTime();

            return {xMetaSize, xMetaOrigin, xMetaModifiedTime, xMetaMD5};
        });
    }

    /**
     * 检查任务是否完成
     *
     * @returns
     * @memberof Transport
     */
    _checkFinish() {
        if (!this.isRunning()) {
            return;
        }

        this._state = TransportStatus.Finished;

        this.emit('finish', {uuid: this._uuid, objectKey: this._objectKey});
    }

    /**
     * 处理错误
     *
     * @param {Error} err
     * @returns
     * @memberof Transport
     */
    _checkError(err) {
        if (!this.isRunning()) {
            return;
        }

        this._state = TransportStatus.Error;

        if (typeof err === 'string') {
            this.emit('error', {uuid: this._uuid, error: err});
        } else if (err instanceof Error || typeof err.message === 'string') {
            this.emit('error', {uuid: this._uuid, error: err.message + err.stack});
        } else if ('status_code' in err) {
            this.emit('error', {uuid: this._uuid, error: `Server code = ${err.status_code}`});
        } else {
            this.emit('error', {uuid: this._uuid, error: '未知错误'});
        }
    }

    _onTimeout() {
        if (this._outputStream && this.isRunning()) {
            this._checkError(new Error('网络连接超时'));
            this._outputStream.end();
        }
    }

    /**
     * 保证`WriteStream`一定可以被close掉
     */
    _checkAlive = debounce(() => this._onTimeout(), 10e3);

    /**
     * 重新下载文件
     *
     * @memberof Transport
     */
    resume(begin = 0, end = 0) {
        /**
         * 如果指定了范围，那么使用文件追加
         */
        this._outputStream = fs.createWriteStream(this._localPath, {flags: begin ? 'a' : 'w'});
        const outputStream = this._outputStream;

        /**
         * 通知节流
         */
        const _notifyProgress = throttle(
            (rate, bytesWritten) => this.emit('rate', {
                uuid: this._uuid,
                objectKey: this._objectKey,
                rate,
                bytesWritten,
            }),
            500,
        );

        /**
         * 统计速率、检查是否沦为僵尸
         */
        const startDate = Date.now();
        outputStream.on('drain', () => {
            const rangeTime = Date.now() - startDate;
            const rate = outputStream.bytesWritten / rangeTime; // kb/s

            _notifyProgress(rate, outputStream.bytesWritten + begin);

            this._checkAlive();
        });

        /**
         * 这里主要检查文件是否有可写权限
         */
        outputStream.on('error', (err) => {
            if (err.code === 'EACCES') {
                this._checkError(err);
            }
        });

        /**
         * Promise的状态不可预期
         */
        this._client.sendRequest('GET', {
            bucketName: this._bucketName,
            key: this._objectKey,
            outputStream,
            headers: {
                Range: begin ? util.format('bytes=%s-%s', begin, end) : '',
            },
        }).then(
            () => this._checkFinish(),
            err => this._checkError(err),
        );
    }

    /**
     * 暂停下载，必须使用`resume`恢复
     *
     * @memberof Transport
     */
    pause() {
        this._state = TransportStatus.Paused;

        if (this._outputStream) {
            this._outputStream.end();
        }

        this.emit('pause', {uuid: this._uuid});
    }

    /**
     * 恢复暂停后的下载任务
     *
     * @memberof Transport
     */
    start() {
        /**
         * 重置状态
         */
        this._state = TransportStatus.Running;

        /**
         * 文件不存在则重新开始
         */
        const isExist = fs.existsSync(this._localPath);
        if (!isExist) {
            /**
             * 目录不存在则创建
             */
            try {
                mkdirp.sync(path.dirname(this._localPath));
                this.resume();
            } catch (ex) {
                this._checkError(ex);
            }
            return;
        }

        /**
         * 没有办法比对本地与BOS上文件是否一致，只能检查文件大小了
         */
        const {size, mtime} = fs.statSync(this._localPath);
        this._fetchMetadata().then(
            (res) => {
                const {xMetaSize, xMetaModifiedTime} = res;
                if (size >= xMetaSize || mtime.getTime() <= xMetaModifiedTime) {
                    /**
                     * 文件不一致，重新下载
                     */
                    return this.resume();
                } else if (size < xMetaSize) {
                    /**
                     * 文件续传
                     */
                    return this.resume(size, xMetaSize);
                }

                /**
                 * 大小一致，认为完成了
                 */
                return this._checkFinish();
            },
            err => this._checkError(err),
        );
    }

    isRunning() {
        return this._state === TransportStatus.Running;
    }

    isUnStarted() {
        return this._state === TransportStatus.UnStarted;
    }
}
