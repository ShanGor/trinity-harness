import { posix } from 'node:path';
import type { ToolContext, BoundedExecResult } from '@trinity-harness/contracts';
import { literalCommandArgv } from './command-prefix.js';
import { bashReferencesSensitiveFile } from './sensitive-files.js';

/** Narrow new-file copy. Unsupported flags retain ordinary shell policy. */
export function workspaceCopyPaths(command: string): [string, string] | undefined {
  const argv = literalCommandArgv(command);
  if (!argv || argv.length !== 3 || argv[0] !== 'cp' || bashReferencesSensitiveFile(command))
    return undefined;
  const paths = argv.slice(1);
  if (
    paths.some(
      (path) =>
        !path ||
        path.startsWith('-') ||
        path.startsWith('/') ||
        posix.normalize(path) !== path ||
        path.split('/').some((part) => part === '..' || part === '.') ||
        Array.from(path).some((char) => char.charCodeAt(0) < 32),
    )
  )
    return undefined;
  return [paths[0]!, paths[1]!];
}

// Directory descriptors pin each traversed parent. O_NOFOLLOW rejects all symlinks;
// O_EXCL prevents a raced-in destination from being replaced. Linux /proc is a
// capability requirement, not a fallback to unguarded cp on other platforms.
export const workspaceCopyScript = `
const fs=require('node:fs'),c=fs.constants,held=[];
try {
 if(process.platform!=='linux') throw Error('unsupported');
 const root=fs.openSync('.',c.O_RDONLY|c.O_DIRECTORY);held.push(root);
 const leaf=path=>{const parts=path.split('/');let fd=root;
  for(const part of parts.slice(0,-1)){fd=fs.openSync('/proc/self/fd/'+fd+'/'+part,c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW);held.push(fd);}
  return '/proc/self/fd/'+fd+'/'+parts.at(-1);};
 const source=fs.openSync(leaf(process.argv[1]),c.O_RDONLY|c.O_NOFOLLOW|c.O_NONBLOCK);held.push(source);
 const stat=fs.fstatSync(source);if(!stat.isFile()||stat.size>16777216)throw Error('source');
 const target=leaf(process.argv[2]);
 if(process.argv[3]==='probe'){
  try{fs.lstatSync(target);process.stdout.write('exists');}
  catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('new');}
 }else{
  const dest=fs.openSync(target,c.O_WRONLY|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o600);held.push(dest);
  const buffer=Buffer.alloc(65536);let total=0,n;
  while((n=fs.readSync(source,buffer,0,buffer.length,null))>0){total+=n;if(total>16777216)throw Error('limit');let offset=0;while(offset<n)offset+=fs.writeSync(dest,buffer,offset,n-offset);}
  process.stdout.write(String(total));
 }
}catch{process.stderr.write('Workspace copy unavailable or destination exists; no existing file was replaced.');process.exitCode=1;}
finally{for(const fd of held.reverse())fs.closeSync(fd);}
`;

export async function workspaceCopy(
  paths: [string, string],
  ctx: ToolContext,
  probe: boolean,
): Promise<BoundedExecResult | undefined> {
  if (!ctx.sandbox.execArgv) return undefined;
  return ctx.sandbox.execArgv(
    'node',
    ['-e', workspaceCopyScript, ...paths, probe ? 'probe' : 'copy'],
    {
      maxOutputBytes: 1024,
      timeoutMs: 5000,
      signal: ctx.signal,
    },
  );
}
