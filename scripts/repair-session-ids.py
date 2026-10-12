# 修复历史会话日志里缺失消息 id 的事件。
#
# 背景：dsh-autoresearch 的 pre-step 注入消息曾不带 id（写入端缺陷）。
# user/message 等消息事件的存储校验要求非空 id，缺 id 的会话在加载时被
# 整体拒绝（「历史加载失败」）。本脚本给缺 id 的消息事件补 randomUUID ——
# 只补写入端本应生成的身份，不改动任何对话内容。
#
# 会话日志是多帧 zstd（逐事件追加），python zstandard 的流式读取原生支持
# 串联帧；重写为单帧（harness 读取端按帧扫描，单帧兼容）。
#
# 用法：python scripts/repair-session-ids.py [--dsh-home <路径>] [--dry-run]
import argparse
import io
import json
import os
import sys
import uuid
from datetime import datetime

try:
    import zstandard
except ImportError:
    print('缺少 zstandard 模块：pip install zstandard')
    sys.exit(1)

MESSAGE_TYPES = {'developer/message', 'system/message', 'user/message', 'assistant/message', 'tool/result'}


def message_id_ok(event):
    """与 harness 存储校验同规则（只查本脚本关心的 id/形状）。"""
    if event.get('type') not in MESSAGE_TYPES:
        return True, None
    data = event.get('data')
    if not isinstance(data, dict):
        return False, None
    message = data if event['type'] == 'user/message' else data.get('message')
    if not isinstance(message, dict):
        return False, None
    return (isinstance(message.get('id'), str) and message['id'] != ''), message


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dsh-home', default=None)
    parser.add_argument('--dry-run', action='store_true')
    options = parser.parse_args()

    dsh_home = options.dsh_home or os.environ.get('DSH_HOME') or os.path.join(os.getcwd(), '.dsh-home')
    dsh_home = os.path.abspath(dsh_home)
    sessions_dir = os.path.join(dsh_home, 'sessions')
    if not os.path.isdir(sessions_dir):
        print(f'没有会话目录：{sessions_dir}')
        return

    dctx = zstandard.ZstdDecompressor()
    cctx = zstandard.ZstdCompressor()
    scanned = repaired_files = repaired_events = 0

    for workspace in sorted(os.listdir(sessions_dir)):
        workspace_dir = os.path.join(sessions_dir, workspace)
        if not os.path.isdir(workspace_dir):
            continue
        for session in sorted(os.listdir(workspace_dir)):
            log_path = os.path.join(workspace_dir, session, 'session.v4.jsonl.zstd')
            if not os.path.isfile(log_path):
                continue
            scanned += 1
            try:
                compressed = open(log_path, 'rb').read()
                text = dctx.stream_reader(io.BytesIO(compressed)).read().decode('utf-8', 'replace')
            except Exception as error:
                print(f'  跳过（解压失败）{session}: {error}')
                continue
            lines = text.split('\n')
            changed = False
            fixed_lines = []
            for line in lines:
                if line.strip() == '':
                    fixed_lines.append(line)
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    fixed_lines.append(line)
                    continue
                if event.get('type') == 'session':
                    fixed_lines.append(line)
                    continue
                ok, message = message_id_ok(event)
                if ok or message is None:
                    fixed_lines.append(line)
                    continue
                message['id'] = str(uuid.uuid4())
                changed = True
                repaired_events += 1
                fixed_lines.append(json.dumps(event, ensure_ascii=False))
            if not changed:
                continue
            print(f'  修复 {session}：补 {repaired_events} 个 id（累计）')
            if options.dry_run:
                continue
            backup = f'{log_path}.bak-{datetime.now().strftime("%Y%m%d-%H%M%S")}'
            open(backup, 'wb').write(compressed)
            payload = cctx.compress('\n'.join(fixed_lines).encode('utf-8'))
            open(log_path, 'wb').write(payload)
            repaired_files += 1

    mode = '（dry-run 未写入）' if options.dry_run else ''
    print(f'扫描会话：{scanned} 个；修复文件：{mode}{repaired_files} 个；补 id 事件：{repaired_events} 条')
    if repaired_files > 0 and not options.dry_run:
        print('原文件已备份为 session.v4.jsonl.zstd.bak-<时间戳>')


if __name__ == '__main__':
    main()
