/**
 * 文件下载模块
 *
 * @file src/uploader/Transport.js
 * @author mudio(job.zhanghao@gmail.com)
 */

import fs from 'fs';
import queue from 'async/queue';
import debounce from 'lodash.debounce';
import {CONTENT_LENGTH, CONTENT_TYPE} from 'bce-sdk-js/src/headers';

import Transport from './transport';
import {TransportStatus} from '../headers';

const kPartSize = 20 * 1024 * 1024;

export default class MultiTransport extends Transport {
    constructor(credentials, config) {
        super(credentials, config);

        this._queue = null;
    }

    // 最多分片1000片，除了最后一片其他片大小相等且大于等于UploadConfig.PartSize
    _decompose(orderedParts, maxParts, uploadSize, totalSize) {
        const minPartSize = Math.ceil(totalSize / (maxParts - orderedParts.length));
        const averagePartSize = Math.max(kPartSize, minPartSize);

        // 余下分片
        const remainParts = [];

        let leftSize = totalSize - uploadSize;
        let offset = uploadSize;
        let partNumber = orderedParts.length + 1;

        while (leftSize > 0) {
            const partSize = Math.min(leftSize, averagePartSize);

            remainParts.push({partNumber, partSize, start: offset});

            leftSize -= partSize;
            offset += partSize;
            partNumber += 1;
        }

        return remainParts;
    }

    _checkAlive = debounce(() => this._stream.emit('abort'), 10e3);

    _invoke({partNumber, partSize, start}, done) {
        /**
         * 读取流
         */
        this._stream = fs.createReadStream(this._localPath, {
            start,
            end: start + partSize - 1, // eslint-disable-line no-mixed-operators
        });

        /**
         * 通知进度
         */
        this._stream.on('progress', ({rate, bytesWritten}) => {
            this._checkAlive();

            this.emit('progress', {rate, bytesWritten: this._uploadedSize + bytesWritten, uuid: this._uuid});
        });

        const headers = {};
        headers[CONTENT_LENGTH] = partSize;
        headers[CONTENT_TYPE] = 'application/octet-stream';
        const options = this._client._checkOptions(headers);

        return this._client.sendRequest('PUT', {
            bucketName: this._bucketName,
            key: this._objectKey,
            body: this._stream,
            headers: options.headers,
            params: {partNumber, uploadId: this._uploadId},
            config: options.config,
        }).then(
            () => {
                this._uploadedSize += partSize;
                done();
            },
            err => done(err),
        );
    }

    /**
     * 重新下载文件
     *
     * @memberof MultiTransport
     */
    resume(remainParts = []) {
        return new Promise((resolve, reject) => {
            this._queue = queue((...args) => this._invoke(...args), 1);

            this._queue.error = (err) => {
                this._queue.kill();
                reject(err);
            };

            this._queue.drain = () => resolve();

            this._queue.push(remainParts);
        });
    }

    /**
     * 恢复暂停后的下载任务
     *
     * @memberof MultiTransport
     */
    async start() {
        /**
         * 重置状态
         */
        this._state = TransportStatus.Running;

        /**
         * 文件不存在还玩个蛋
         */
        const isExist = fs.existsSync(this._localPath);
        if (!isExist) {
            return this._checkError(new Error(`file not found ${this.localPath}`));
        }

        try {
            const {size} = fs.statSync(this._localPath);

            // 如果文件大于阈值并且没有uploadId，则获取一次
            if (!this._uploadId) {
                // 先检查如果文件已经在bos上了，则忽略
                if (await this._checkConsistency()) {
                    return this._checkFinish();
                }

                const {uploadId} = await this._initUploadId();
                this._uploadId = uploadId;
            }
            // 获取已上传到分片
            const {parts, maxParts} = await this._fetchParts();
            // 重新分片
            const orderedParts = parts.sort((lhs, rhs) => lhs.partNumber - rhs.partNumber);
            this._uploadedSize = parts.reduce((pre, cur) => pre + cur.size, 0);
            const remainParts = this._decompose(orderedParts, maxParts, this._uploadedSize, size);
            // 上传遗留的分片
            if (remainParts.length > 0) {
                this.emit('start', {
                    uuid: this._uuid,
                    uploadId: this._uploadId,
                    localPath: this._localPath,
                });
                await this.resume(remainParts);
            }
            // 完成任务,用文件大小来效验文件一致性
            await this._completeUpload();
            // 检查任务完成状态
            this._checkFinish();
        } catch (ex) {
            this._checkError(ex);
        }
    }
}
