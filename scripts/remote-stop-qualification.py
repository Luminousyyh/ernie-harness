"""Ask qualification to stop after saving its current record; never kill jobs."""
import pathlib,json,fcntl
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness')
marker=root/'eval/qualification/stop-after-current'
marker.parent.mkdir(parents=True,exist_ok=True)
marker.touch(exist_ok=True)
with (root/'eval/resource.lock').open('a') as lock:
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        released=True
    except BlockingIOError:
        released=False
print(json.dumps({'stopAfterCurrent':str(marker),'resourceLockFree':released,'processesSignalled':0}))
