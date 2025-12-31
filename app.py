import asyncio
import psutil
import time
import json
from fastapi import FastAPI, WebSocket, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse
import pynvml

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")

# 初始化 NVML
nvml_initialized = False
try:
    pynvml.nvmlInit()
    nvml_initialized = True
except Exception as e:
    print(f"Warning: NVML init failed, GPU monitoring disabled. Error: {e}")

def get_size(bytes, suffix="B"):
    """
    Scale bytes to its proper format
    e.g:
        1253656 => '1.20MB'
        1253656678 => '1.17GB'
    """
    factor = 1024
    for unit in ["", "K", "M", "G", "T", "P"]:
        if bytes < factor:
            return f"{bytes:.2f}{unit}{suffix}"
        bytes /= factor

def get_system_stats():
    # CPU
    cpu_percent = psutil.cpu_percent(interval=None)
    
    # Memory
    svmem = psutil.virtual_memory()
    memory_stats = {
        "total": get_size(svmem.total),
        "available": get_size(svmem.available),
        "percent": svmem.percent,
        "used": get_size(svmem.used)
    }

    # Disk
    partitions = psutil.disk_partitions()
    disk_stats = []
    for partition in partitions:
        try:
            partition_usage = psutil.disk_usage(partition.mountpoint)
            disk_stats.append({
                "device": partition.device,
                "mountpoint": partition.mountpoint,
                "total": get_size(partition_usage.total),
                "used": get_size(partition_usage.used),
                "percent": partition_usage.percent
            })
        except PermissionError:
            continue

    # Network
    net_io = psutil.net_io_counters()
    net_stats = {
        "bytes_sent": get_size(net_io.bytes_sent),
        "bytes_recv": get_size(net_io.bytes_recv),
        # We will calculate speed in the loop
        "raw_sent": net_io.bytes_sent,
        "raw_recv": net_io.bytes_recv
    }

    return {
        "cpu": cpu_percent,
        "memory": memory_stats,
        "disk": disk_stats,
        "network": net_stats
    }

def get_gpu_stats():
    if not nvml_initialized:
        return []
    
    gpus = []
    try:
        device_count = pynvml.nvmlDeviceGetCount()
        for i in range(device_count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode('utf-8')
            
            utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            power_usage = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0 # mW to W
            try:
                power_limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
            except:
                power_limit = 0
            
            temperature = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            
            # Get processes and users
            users = set()
            try:
                processes = pynvml.nvmlDeviceGetComputeRunningProcesses(handle) + \
                            pynvml.nvmlDeviceGetGraphicsRunningProcesses(handle)
                for p in processes:
                    try:
                        process = psutil.Process(p.pid)
                        users.add(process.username())
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except Exception as e:
                print(f"Error getting GPU processes: {e}")

            gpus.append({
                "id": i,
                "name": name,
                "users": list(users),
                "gpu_util": utilization.gpu,
                "mem_util": utilization.memory, # This is bandwidth utilization in some contexts, but nvmlDeviceGetUtilizationRates returns % of time accessing memory
                "mem_total": get_size(memory.total),
                "mem_used": get_size(memory.used),
                "mem_percent": round((memory.used / memory.total) * 100, 1),
                "power_usage": round(power_usage, 1),
                "power_limit": round(power_limit, 1),
                "temperature": temperature
            })
    except Exception as e:
        print(f"Error reading GPU stats: {e}")
        
    return gpus

@app.get("/")
async def get():
    return FileResponse("templates/index.html")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    last_net_io = psutil.net_io_counters()
    last_time = time.time()

    try:
        while True:
            current_time = time.time()
            time_diff = current_time - last_time
            if time_diff < 1:
                time_diff = 1 # Avoid division by zero or tiny numbers

            sys_stats = get_system_stats()
            gpu_stats = get_gpu_stats()
            
            # Calculate Network Speed
            current_net_io = psutil.net_io_counters()
            bytes_sent_sec = (current_net_io.bytes_sent - last_net_io.bytes_sent) / time_diff
            bytes_recv_sec = (current_net_io.bytes_recv - last_net_io.bytes_recv) / time_diff
            
            sys_stats["network"]["speed_sent"] = get_size(bytes_sent_sec) + "/s"
            sys_stats["network"]["speed_recv"] = get_size(bytes_recv_sec) + "/s"
            sys_stats["network"]["speed_sent_bytes"] = bytes_sent_sec
            sys_stats["network"]["speed_recv_bytes"] = bytes_recv_sec
            
            last_net_io = current_net_io
            last_time = current_time

            data = {
                "system": sys_stats,
                "gpus": gpu_stats,
                "timestamp": current_time
            }
            
            await websocket.send_text(json.dumps(data))
            await asyncio.sleep(1) # Update every 1 second
    except Exception as e:
        print(f"WebSocket disconnected: {e}")
