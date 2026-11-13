"""Deploy source/build assets to the user-authorized Linux app, without credentials.
Password is read interactively or from ERNIE_SSH_PASSWORD at runtime only.
Does not launch experiments, stop services, or replace dependency trees.
"""
from __future__ import annotations
import argparse, getpass, os, pathlib, posixpath
import paramiko

REMOTE_ROOT = '/home/home_new/yaoyh/ernie-harness/app'

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--host',default='10.15.196.230')
 parser.add_argument('--port',type=int,default=51700)
 parser.add_argument('--user',default='yaoyh')
 args=parser.parse_args()
 root=pathlib.Path(__file__).resolve().parent.parent
 paths=[root/n for n in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','vitest.config.ts','AGENTS.md','eval/qualification_support.py','scripts/remote-evaluate.py','scripts/sync-evaluation.py','eval/observability-v2-native-event-samples-20261113.json']]
 paths.extend((root/'scripts').glob('remote-*.py'))
 paths.extend((root/'eval').glob('*.py'))
 for name in ['src','tests','dist','web/src','web/public','web/dist']:
  paths.extend(p for p in (root/name).rglob('*') if p.is_file() and not p.is_symlink())
 paths.extend(p for p in (root/'web').iterdir() if p.is_file())
 client=paramiko.SSHClient();client.load_system_host_keys()
 # Host was explicitly supplied by the user; verify existing known hosts and allow its initial connection.
 client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
 client.connect(args.host,port=args.port,username=args.user,password=os.environ.get('ERNIE_SSH_PASSWORD') or getpass.getpass('SSH password: '),timeout=15)
 try:
  sftp=client.open_sftp();made={REMOTE_ROOT}
  def directory(path):
   if path in made:return
   directory(posixpath.dirname(path))
   try:sftp.mkdir(path)
   except OSError:sftp.stat(path)
   made.add(path)
  made.update(['/','/home','/home/home_new','/home/home_new/yaoyh','/home/home_new/yaoyh/ernie-harness'])
  for local in sorted(set(paths)):
   relative=local.relative_to(root).as_posix()
   if '..' in relative.split('/') or relative.startswith('/') or '.env' in local.name:raise ValueError('unsafe deploy path')
   target=REMOTE_ROOT+'/'+relative;directory(posixpath.dirname(target))
   temporary=target+'.deploy-part'
   sftp.put(str(local),temporary);sftp.posix_rename(temporary,target)
  print('Uploaded',len(set(paths)),'app files; dependency trees and evaluation state preserved.')
 finally:client.close()
if __name__=='__main__':main()
