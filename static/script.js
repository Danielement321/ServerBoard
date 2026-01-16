const { createApp, ref, onMounted, nextTick } = Vue;

createApp({
    setup() {
        const stats = ref({});
        const connected = ref(false);
        const isDarkMode = ref(localStorage.getItem('darkMode') === 'true');
        let ws = null;
        let cpuChart = null;
        let gpuChart = null;
        let netChart = null;

        const getThemeTextColor = () => isDarkMode.value ? '#ccc' : '#333';

        const toggleDarkMode = () => {
            isDarkMode.value = !isDarkMode.value;
            localStorage.setItem('darkMode', isDarkMode.value);
            if (isDarkMode.value) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
            
            const textColor = getThemeTextColor();
            const opts = { legend: { textStyle: { color: textColor } } };
            
            if (cpuChart) cpuChart.setOption(opts);
            if (gpuChart) gpuChart.setOption(opts);
            if (netChart) netChart.setOption(opts);
        };

        if (isDarkMode.value) {
            document.documentElement.classList.add('dark');
        }
        
        // Chart Data Arrays
        const maxDataPoints = 60; // 1 minute history
        const timeLabels = [];
        const cpuData = [];
        const memData = [];
        const netSentData = [];
        const netRecvData = [];
        const gpuData = {}; // Map of gpu_id -> array

        // Monitor Vars
        const gpuMonitors = ref(JSON.parse(localStorage.getItem('gpuMonitors') || '{}'));
        const showMonitorModal = ref(false);
        const currentEditingGpu = ref(null);
        const monitorForm = ref({ enabled: false, threshold: 10, duration: 60 });
        const pendingAlerts = ref({});

        const isMonitorEnabled = (id) => gpuMonitors.value[id]?.enabled;

        const openMonitorModal = (gpu) => {
            currentEditingGpu.value = gpu;
            const settings = gpuMonitors.value[gpu.id] || { enabled: false, threshold: 10, duration: 60 };
            monitorForm.value = { ...settings };
            showMonitorModal.value = true;
        };

        const closeMonitorModal = () => {
            showMonitorModal.value = false;
            currentEditingGpu.value = null;
        };

        const saveMonitorSettings = () => {
            if (currentEditingGpu.value) {
                gpuMonitors.value[currentEditingGpu.value.id] = { ...monitorForm.value };
                localStorage.setItem('gpuMonitors', JSON.stringify(gpuMonitors.value));
                
                if (monitorForm.value.enabled && Notification.permission !== 'granted') {
                    Notification.requestPermission();
                }
            }
            closeMonitorModal();
        };

        const playBeep = () => {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) return;
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = 880;
                gain.gain.value = 0.1;
                osc.start();
                setTimeout(() => { osc.stop(); ctx.close(); }, 500);
            } catch (e) {
                console.error("Audio error", e);
            }
        };

        const checkGpuAlerts = (data) => {
            if (!data.gpus) return;
            data.gpus.forEach(gpu => {
                const settings = gpuMonitors.value[gpu.id];
                if (settings && settings.enabled) {
                    if (gpu.mem_percent <= settings.threshold) {
                        if (!pendingAlerts.value[gpu.id]) {
                            pendingAlerts.value[gpu.id] = Date.now();
                        } else {
                            const elapsed = (Date.now() - pendingAlerts.value[gpu.id]) / 1000;
                            if (elapsed >= settings.duration) {
                                // Trigger Alert
                                playBeep();
                                if (Notification.permission === 'granted') {
                                    new Notification(`GPU 空载通知`, {
                                        body: `${gpu.name} [ID:${gpu.id}] 显存使用率低 (${gpu.mem_percent}%) 已持续 ${Math.floor(elapsed)}秒`,
                                    });
                                }
                                
                                // Auto turn off as requested
                                settings.enabled = false;
                                gpuMonitors.value[gpu.id] = settings;
                                localStorage.setItem('gpuMonitors', JSON.stringify(gpuMonitors.value));
                                delete pendingAlerts.value[gpu.id];
                            }
                        }
                    } else {
                        if (pendingAlerts.value[gpu.id]) {
                            delete pendingAlerts.value[gpu.id];
                        }
                    }
                } else {
                   if (pendingAlerts.value[gpu.id]) delete pendingAlerts.value[gpu.id];
                }
            });
        };

        const getBarColor = (percent) => {
            if (percent >= 90) return 'bg-red-500';
            if (percent >= 70) return 'bg-orange-500';
            return 'bg-blue-600'; // Default color
        };

        const initCpuChart = () => {
            const el = document.getElementById('cpuChart');
            if (!el) return;
            
            cpuChart = echarts.init(el);
            const option = {
                tooltip: { trigger: 'axis' },
                legend: { data: ['CPU', 'Memory'], textStyle: { fontSize: 10, color: getThemeTextColor() }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: { type: 'value', max: 100, min: 0, splitLine: { show: false }, axisLabel: { color: getThemeTextColor() } },
                series: [
                    { name: 'CPU', type: 'line', smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.1 }, itemStyle: { color: '#3b82f6' } },
                    { name: 'Memory', type: 'line', smooth: true, showSymbol: false, data: [], itemStyle: { color: '#a855f7' } }
                ]
            };
            cpuChart.setOption(option);
        };

        const initGpuChart = () => {
            const el = document.getElementById('gpuChart');
            if (!el || gpuChart) return;

            gpuChart = echarts.init(el);
            const option = {
                tooltip: { trigger: 'axis' },
                legend: { data: [], textStyle: { fontSize: 10, color: getThemeTextColor() }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: { type: 'value', max: 100, min: 0, splitLine: { show: false }, axisLabel: { color: getThemeTextColor() } },
                series: []
            };
            gpuChart.setOption(option);
        };

        const initNetChart = () => {
            const el = document.getElementById('netChart');
            if (!el) return;

            netChart = echarts.init(el);
            const option = {
                tooltip: { 
                    trigger: 'axis',
                    formatter: function (params) {
                        let result = params[0].name + '<br/>';
                        params.forEach(item => {
                            // Convert bytes to readable format
                            let val = item.value;
                            let unit = 'B/s';
                            if (val > 1024) { val /= 1024; unit = 'KB/s'; }
                            if (val > 1024 * 1024) { val /= 1024; unit = 'MB/s'; }
                            result += item.marker + " " + item.seriesName + ": " + val.toFixed(1) + unit + '<br/>';
                        });
                        return result;
                    }
                },
                legend: { data: ['Down', 'Up'], textStyle: { fontSize: 10, color: getThemeTextColor() }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: { type: 'value', splitLine: { show: false }, axisLabel: { color: getThemeTextColor(), formatter: (value) => {
                    if (value > 1024 * 1024) return (value / 1024 / 1024).toFixed(0) + 'M';
                    if (value > 1024) return (value / 1024).toFixed(0) + 'K';
                    return value;
                }}},
                series: [
                    { name: 'Down', type: 'line', smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.1 }, itemStyle: { color: '#10b981' } },
                    { name: 'Up', type: 'line', smooth: true, showSymbol: false, data: [], itemStyle: { color: '#3b82f6' } }
                ]
            };
            netChart.setOption(option);
        };

        const updateCharts = (data) => {
            const now = new Date();
            const timeStr = now.getHours().toString().padStart(2, '0') + ':' + 
                          now.getMinutes().toString().padStart(2, '0') + ':' + 
                          now.getSeconds().toString().padStart(2, '0');
            
            if (timeLabels.length > maxDataPoints) {
                timeLabels.shift();
                cpuData.shift();
                memData.shift();
                netSentData.shift();
                netRecvData.shift();
            }
            timeLabels.push(timeStr);
            cpuData.push(data.system.cpu);
            memData.push(data.system.memory.percent);
            
            // Network Data (Bytes/s)
            netSentData.push(data.system.network.speed_sent_bytes || 0);
            netRecvData.push(data.system.network.speed_recv_bytes || 0);

            if (cpuChart) {
                cpuChart.setOption({
                    xAxis: { data: timeLabels },
                    series: [
                        { data: cpuData },
                        { data: memData }
                    ]
                });
            }

            if (netChart) {
                netChart.setOption({
                    xAxis: { data: timeLabels },
                    series: [
                        { data: netRecvData },
                        { data: netSentData }
                    ]
                });
            }

            // GPU Chart Update
            if (data.gpus && data.gpus.length > 0) {
                if (!gpuChart) {
                    nextTick(() => {
                        initGpuChart();
                    });
                }

                if (gpuChart) {
                    const series = [];
                    const legendData = [];
                    
                    data.gpus.forEach((gpu, index) => {
                        const id = gpu.id;
                        const name = `GPU ${id}`;
                        legendData.push(name);
                        
                        if (!gpuData[id]) gpuData[id] = [];
                        if (gpuData[id].length > maxDataPoints) gpuData[id].shift();
                        gpuData[id].push(gpu.gpu_util);
                        
                        const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6'];
                        const color = colors[index % colors.length];

                        series.push({
                            name: name,
                            type: 'line',
                            smooth: true,
                            showSymbol: false,
                            data: gpuData[id],
                            itemStyle: { color: color },
                            areaStyle: { opacity: 0.1 }
                        });
                    });

                    gpuChart.setOption({
                        legend: { data: legendData },
                        xAxis: { data: timeLabels },
                        series: series
                    });
                }
            }
        };

        const connect = () => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

            ws.onopen = () => {
                connected.value = true;
                console.log("Connected to WebSocket");
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                stats.value = data;
                
                checkGpuAlerts(data);

                if (!cpuChart) {
                    nextTick(() => {
                        initCpuChart();
                        initNetChart();
                        updateCharts(data);
                    });
                } else {
                    updateCharts(data);
                }
            };

            ws.onclose = () => {
                connected.value = false;
                console.log("Disconnected. Reconnecting in 3s...");
                setTimeout(connect, 3000);
            };
            
            ws.onerror = (err) => {
                console.error("WebSocket error:", err);
                ws.close();
            };
        };

        onMounted(() => {
            connect();
            window.addEventListener('resize', () => {
                if(cpuChart) cpuChart.resize();
                if(gpuChart) gpuChart.resize();
                if(netChart) netChart.resize();
            });
        });

        return {
            stats,
            connected,
            isDarkMode,
            toggleDarkMode,
            getBarColor,
            showMonitorModal,
            monitorForm,
            openMonitorModal,
            closeMonitorModal,
            saveMonitorSettings,
            isMonitorEnabled
        };
    }
}).mount('#app');
