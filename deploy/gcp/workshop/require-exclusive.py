import subprocess,sys
units=['pi-durable-coordinator.service', 'pi-durable-acceptance-coordinator.service', 'pi-durable-acceptance-s2-coordinator.service', 'pi-durable-acceptance-s3-coordinator.service']
for u in units:
 p=subprocess.run(["systemctl","show",u,"-p","MainPID","--value"],capture_output=True,text=True,timeout=10)
 if p.returncode or p.stdout.strip()!="0":sys.exit(1)
