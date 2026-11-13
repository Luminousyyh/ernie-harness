"""Byte-transparent loopback HTTP -> broker Unix socket relay inside bwrap.

The relay does not decode/log authorization or requests. The broker must reject
all routes except model calls and enforce fake-token registration and budgets.
"""
import argparse, asyncio, os, signal, sys
async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data); await writer.drain()
    except (ConnectionError, asyncio.CancelledError): pass
    finally:
        writer.close()
async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--socket',required=True);parser.add_argument('--port',type=int,default=18080);parser.add_argument('command',nargs=argparse.REMAINDER)
    args=parser.parse_args(); command=args.command[1:] if args.command[:1]==['--'] else args.command
    async def accept(reader,writer):
        try: upstream_reader,upstream_writer=await asyncio.open_unix_connection(args.socket)
        except OSError: writer.close();return
        await asyncio.gather(pipe(reader,upstream_writer),pipe(upstream_reader,writer))
    server=await asyncio.start_server(accept,'127.0.0.1',args.port)
    async with server:
        if not command: await server.serve_forever();return 0
        child=await asyncio.create_subprocess_exec(*command)
        loop=asyncio.get_running_loop()
        for sig in [signal.SIGTERM,signal.SIGINT]:
            loop.add_signal_handler(sig,lambda s=sig: child.send_signal(s) if child.returncode is None else None)
        return await child.wait()
if __name__=='__main__':sys.exit(asyncio.run(main()))
