const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick } = Vue;

createApp({
    setup() {
        const stats = ref({});
        const connected = ref(false);
        const isDarkMode = ref(localStorage.getItem('darkMode') === 'true');

        let ws = null;
        let cpuChart = null;
        let gpuChart = null;
        let netChart = null;

        const maxDataPoints = 60;
        const timeLabels = [];
        const cpuData = [];
        const memData = [];
        const netSentData = [];
        const netRecvData = [];
        const gpuData = {};

        const gpuMonitors = ref(JSON.parse(localStorage.getItem('gpuMonitors') || '{}'));
        const showMonitorModal = ref(false);
        const currentEditingGpu = ref(null);
        const monitorForm = ref({ enabled: false, threshold: 5 });
        const diskSelections = ref(JSON.parse(localStorage.getItem('diskSelections') || '{}'));
        const showDiskMenu = ref(false);

        const activeAlerts = ref({});
        const belowThresholdState = ref({});
        const audioStatus = ref('idle');

        let audioContext = null;
        let alarmInterval = null;
        let audioUnlockCleanup = null;

        const getThemeTextColor = () => (isDarkMode.value ? '#d1d5db' : '#374151');
        const activeAlertList = computed(() => Object.values(activeAlerts.value));
        const isAlarmSounding = computed(() => activeAlertList.value.some((alert) => !alert.acknowledged));
        const diskList = computed(() => stats.value.system?.disk || []);
        const visibleDisks = computed(() => {
            syncDiskSelections(diskList.value);
            return diskList.value.filter((disk) => diskSelections.value[disk.mountpoint] !== false);
        });

        const persistMonitors = () => {
            localStorage.setItem('gpuMonitors', JSON.stringify(gpuMonitors.value));
        };
        const persistDiskSelections = () => {
            localStorage.setItem('diskSelections', JSON.stringify(diskSelections.value));
        };

        const getDefaultMonitorSettings = () => ({ enabled: false, threshold: 5 });
        const getMonitorSettings = (gpuId) => gpuMonitors.value[gpuId] || getDefaultMonitorSettings();
        const isMonitorEnabled = (gpuId) => !!getMonitorSettings(gpuId).enabled;
        const getMonitorThreshold = (gpuId) => getMonitorSettings(gpuId).threshold ?? 5;
        const areAllDisksSelected = computed(() => diskList.value.length > 0 && visibleDisks.value.length === diskList.value.length);

        const syncDiskSelections = (disks) => {
            if (!disks?.length) return;

            let changed = false;
            const existingMounts = new Set(disks.map((disk) => disk.mountpoint));

            disks.forEach((disk) => {
                if (!(disk.mountpoint in diskSelections.value)) {
                    diskSelections.value[disk.mountpoint] = true;
                    changed = true;
                }
            });

            Object.keys(diskSelections.value).forEach((mountpoint) => {
                if (!existingMounts.has(mountpoint)) {
                    delete diskSelections.value[mountpoint];
                    changed = true;
                }
            });

            if (changed) {
                persistDiskSelections();
            }
        };

        const toggleDiskMenu = () => {
            showDiskMenu.value = !showDiskMenu.value;
        };

        const closeDiskMenu = () => {
            showDiskMenu.value = false;
        };

        const setDiskVisibility = (mountpoint, visible) => {
            diskSelections.value[mountpoint] = visible;
            persistDiskSelections();
        };

        const toggleDiskVisibility = (mountpoint) => {
            setDiskVisibility(mountpoint, diskSelections.value[mountpoint] === false);
        };

        const selectAllDisks = () => {
            diskList.value.forEach((disk) => {
                diskSelections.value[disk.mountpoint] = true;
            });
            persistDiskSelections();
        };

        const clearDiskSelections = () => {
            diskList.value.forEach((disk) => {
                diskSelections.value[disk.mountpoint] = false;
            });
            persistDiskSelections();
        };

        const applyTheme = () => {
            document.documentElement.classList.toggle('dark', isDarkMode.value);
            const textColor = getThemeTextColor();
            const option = { legend: { textStyle: { color: textColor } } };
            if (cpuChart) cpuChart.setOption(option);
            if (gpuChart) gpuChart.setOption(option);
            if (netChart) netChart.setOption(option);
        };

        const toggleDarkMode = () => {
            isDarkMode.value = !isDarkMode.value;
            localStorage.setItem('darkMode', String(isDarkMode.value));
            applyTheme();
        };

        const ensureAudioContext = async () => {
            try {
                const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextCtor) {
                    audioStatus.value = 'unsupported';
                    return null;
                }

                if (!audioContext || audioContext.state === 'closed') {
                    audioContext = new AudioContextCtor();
                }

                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }

                audioStatus.value = audioContext.state === 'running' ? 'ready' : 'blocked';
                return audioContext;
            } catch (error) {
                console.error('Audio init error:', error);
                audioStatus.value = 'blocked';
                return null;
            }
        };

        const playBeep = async () => {
            const context = await ensureAudioContext();
            if (!context) return false;

            try {
                const oscillator = context.createOscillator();
                const gain = context.createGain();

                oscillator.type = 'square';
                oscillator.frequency.setValueAtTime(880, context.currentTime);

                gain.gain.setValueAtTime(0.0001, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);

                oscillator.connect(gain);
                gain.connect(context.destination);

                oscillator.start(context.currentTime);
                oscillator.stop(context.currentTime + 0.42);

                audioStatus.value = 'ready';
                return true;
            } catch (error) {
                console.error('Audio playback error:', error);
                audioStatus.value = 'blocked';
                return false;
            }
        };

        const stopAlarmSound = () => {
            if (alarmInterval) {
                clearInterval(alarmInterval);
                alarmInterval = null;
            }
            if (audioStatus.value === 'playing') {
                audioStatus.value = 'ready';
            }
        };

        const startAlarmSound = async () => {
            if (!isAlarmSounding.value) {
                stopAlarmSound();
                return;
            }
            if (alarmInterval) return;

            const firstBeepPlayed = await playBeep();
            if (!firstBeepPlayed) return;

            audioStatus.value = 'playing';
            alarmInterval = setInterval(async () => {
                if (!isAlarmSounding.value) {
                    stopAlarmSound();
                    return;
                }

                const beepPlayed = await playBeep();
                if (!beepPlayed) {
                    stopAlarmSound();
                } else {
                    audioStatus.value = 'playing';
                }
            }, 1200);
        };

        const dismissAlert = (gpuId) => {
            const alert = activeAlerts.value[gpuId];
            if (!alert) return;

            activeAlerts.value[gpuId] = {
                ...alert,
                acknowledged: true,
                endedAt: Date.now()
            };
            delete activeAlerts.value[gpuId];

            if (!isAlarmSounding.value) {
                stopAlarmSound();
            }
        };

        const dismissAllAlerts = () => {
            Object.keys(activeAlerts.value).forEach((gpuId) => dismissAlert(gpuId));
        };

        const sendNotification = (gpu) => {
            if (!('Notification' in window)) return;
            if (Notification.permission === 'granted') {
                new Notification('GPU 低显存报警', {
                    body: `${gpu.name} [ID:${gpu.id}] 显存使用率已降到 ${gpu.mem_percent}%`
                });
            }
        };

        const armBrowserAudio = async () => {
            await ensureAudioContext();
            if (isAlarmSounding.value) {
                startAlarmSound();
            }
        };

        const installAudioUnlockHandlers = () => {
            const handler = () => {
                armBrowserAudio();
            };

            ['click', 'touchstart', 'keydown'].forEach((eventName) => {
                window.addEventListener(eventName, handler, { passive: true });
            });

            audioUnlockCleanup = () => {
                ['click', 'touchstart', 'keydown'].forEach((eventName) => {
                    window.removeEventListener(eventName, handler);
                });
            };
        };

        const triggerGpuAlert = (gpu) => {
            const existing = activeAlerts.value[gpu.id];
            if (existing) {
                activeAlerts.value[gpu.id] = {
                    ...existing,
                    memPercent: gpu.mem_percent,
                    threshold: getMonitorThreshold(gpu.id),
                    lastSeenAt: Date.now()
                };
                if (!existing.acknowledged) {
                    startAlarmSound();
                }
                return;
            }

            activeAlerts.value[gpu.id] = {
                gpuId: gpu.id,
                gpuName: gpu.name,
                memPercent: gpu.mem_percent,
                threshold: getMonitorThreshold(gpu.id),
                startedAt: Date.now(),
                lastSeenAt: Date.now(),
                acknowledged: false
            };

            sendNotification(gpu);
            startAlarmSound();
        };

        const clearAlertForDisabledMonitor = (gpuId) => {
            delete belowThresholdState.value[gpuId];
            if (activeAlerts.value[gpuId]) {
                dismissAlert(gpuId);
            }
        };

        const checkGpuAlerts = (data) => {
            const seenGpuIds = new Set();
            (data.gpus || []).forEach((gpu) => {
                const gpuId = String(gpu.id);
                seenGpuIds.add(gpuId);

                const settings = getMonitorSettings(gpuId);
                if (!settings.enabled) {
                    clearAlertForDisabledMonitor(gpuId);
                    return;
                }

                const isBelowThreshold = gpu.mem_percent <= settings.threshold;
                const wasBelowThreshold = !!belowThresholdState.value[gpuId];

                if (isBelowThreshold && !wasBelowThreshold) {
                    belowThresholdState.value[gpuId] = true;
                    triggerGpuAlert(gpu);
                    return;
                }

                if (isBelowThreshold && wasBelowThreshold && activeAlerts.value[gpuId]) {
                    activeAlerts.value[gpuId] = {
                        ...activeAlerts.value[gpuId],
                        memPercent: gpu.mem_percent,
                        lastSeenAt: Date.now()
                    };
                    return;
                }

                if (!isBelowThreshold) {
                    belowThresholdState.value[gpuId] = false;
                }
            });

            Object.keys(belowThresholdState.value).forEach((gpuId) => {
                if (!seenGpuIds.has(gpuId)) {
                    delete belowThresholdState.value[gpuId];
                }
            });
        };

        const toggleMonitor = (gpu) => {
            const gpuId = String(gpu.id);
            const settings = { ...getMonitorSettings(gpuId) };
            settings.enabled = !settings.enabled;
            gpuMonitors.value[gpuId] = settings;
            persistMonitors();

            if (settings.enabled && 'Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }

            if (!settings.enabled) {
                clearAlertForDisabledMonitor(gpuId);
            }
        };

        const openMonitorModal = (gpu) => {
            const gpuId = String(gpu.id);
            currentEditingGpu.value = gpu;
            monitorForm.value = { ...getMonitorSettings(gpuId) };
            showMonitorModal.value = true;
        };

        const closeMonitorModal = () => {
            showMonitorModal.value = false;
            currentEditingGpu.value = null;
        };

        const saveMonitorSettings = () => {
            if (!currentEditingGpu.value) return;

            const gpuId = String(currentEditingGpu.value.id);
            gpuMonitors.value[gpuId] = {
                enabled: !!monitorForm.value.enabled,
                threshold: Math.max(0, Math.min(100, Number(monitorForm.value.threshold) || 5))
            };
            persistMonitors();

            if (monitorForm.value.enabled && 'Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }

            closeMonitorModal();
        };

        const getBarColor = (percent) => {
            if (percent >= 90) return 'bg-red-500';
            if (percent >= 70) return 'bg-orange-500';
            return 'bg-blue-600';
        };

        const initCpuChart = () => {
            const el = document.getElementById('cpuChart');
            if (!el) return;

            cpuChart = echarts.init(el);
            cpuChart.setOption({
                tooltip: { trigger: 'axis' },
                legend: {
                    data: ['CPU', 'Memory'],
                    textStyle: { fontSize: 10, color: getThemeTextColor() },
                    top: 0
                },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: {
                    type: 'value',
                    max: 100,
                    min: 0,
                    splitLine: { show: false },
                    axisLabel: { color: getThemeTextColor() }
                },
                series: [
                    { name: 'CPU', type: 'line', smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.1 }, itemStyle: { color: '#3b82f6' } },
                    { name: 'Memory', type: 'line', smooth: true, showSymbol: false, data: [], itemStyle: { color: '#a855f7' } }
                ]
            });
        };

        const initGpuChart = () => {
            const el = document.getElementById('gpuChart');
            if (!el || gpuChart) return;

            gpuChart = echarts.init(el);
            gpuChart.setOption({
                tooltip: { trigger: 'axis' },
                legend: { data: [], textStyle: { fontSize: 10, color: getThemeTextColor() }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: {
                    type: 'value',
                    max: 100,
                    min: 0,
                    splitLine: { show: false },
                    axisLabel: { color: getThemeTextColor() }
                },
                series: []
            });
        };

        const initNetChart = () => {
            const el = document.getElementById('netChart');
            if (!el) return;

            netChart = echarts.init(el);
            netChart.setOption({
                tooltip: {
                    trigger: 'axis',
                    formatter(params) {
                        let result = `${params[0]?.name || ''}<br/>`;
                        params.forEach((item) => {
                            let value = item.value;
                            let unit = 'B/s';
                            if (value >= 1024 * 1024) {
                                value /= 1024 * 1024;
                                unit = 'MB/s';
                            } else if (value >= 1024) {
                                value /= 1024;
                                unit = 'KB/s';
                            }
                            result += `${item.marker} ${item.seriesName}: ${value.toFixed(1)} ${unit}<br/>`;
                        });
                        return result;
                    }
                },
                legend: { data: ['Down', 'Up'], textStyle: { fontSize: 10, color: getThemeTextColor() }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20%', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, data: [], show: false },
                yAxis: {
                    type: 'value',
                    splitLine: { show: false },
                    axisLabel: {
                        color: getThemeTextColor(),
                        formatter(value) {
                            if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)}M`;
                            if (value >= 1024) return `${(value / 1024).toFixed(0)}K`;
                            return value;
                        }
                    }
                },
                series: [
                    { name: 'Down', type: 'line', smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.1 }, itemStyle: { color: '#10b981' } },
                    { name: 'Up', type: 'line', smooth: true, showSymbol: false, data: [], itemStyle: { color: '#3b82f6' } }
                ]
            });
        };

        const updateCharts = (data) => {
            const now = new Date();
            const timeLabel = [
                now.getHours().toString().padStart(2, '0'),
                now.getMinutes().toString().padStart(2, '0'),
                now.getSeconds().toString().padStart(2, '0')
            ].join(':');

            if (timeLabels.length >= maxDataPoints) {
                timeLabels.shift();
                cpuData.shift();
                memData.shift();
                netSentData.shift();
                netRecvData.shift();
                Object.values(gpuData).forEach((series) => series.shift());
            }

            timeLabels.push(timeLabel);
            cpuData.push(data.system?.cpu || 0);
            memData.push(data.system?.memory?.percent || 0);
            netSentData.push(data.system?.network?.speed_sent_bytes || 0);
            netRecvData.push(data.system?.network?.speed_recv_bytes || 0);

            if (cpuChart) {
                cpuChart.setOption({
                    xAxis: { data: timeLabels },
                    series: [{ data: cpuData }, { data: memData }]
                });
            }

            if (netChart) {
                netChart.setOption({
                    xAxis: { data: timeLabels },
                    series: [{ data: netRecvData }, { data: netSentData }]
                });
            }

            if (data.gpus?.length) {
                if (!gpuChart) {
                    nextTick(() => initGpuChart());
                }

                if (gpuChart) {
                    const legendData = [];
                    const series = [];
                    const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#14b8a6'];

                    data.gpus.forEach((gpu, index) => {
                        const gpuId = String(gpu.id);
                        const label = `GPU ${gpu.id}`;
                        legendData.push(label);

                        if (!gpuData[gpuId]) {
                            gpuData[gpuId] = Array(Math.max(0, timeLabels.length - 1)).fill(0);
                        }
                        gpuData[gpuId].push(gpu.gpu_util);

                        series.push({
                            name: label,
                            type: 'line',
                            smooth: true,
                            showSymbol: false,
                            data: gpuData[gpuId],
                            itemStyle: { color: colors[index % colors.length] },
                            areaStyle: { opacity: 0.1 }
                        });
                    });

                    gpuChart.setOption({
                        legend: { data: legendData },
                        xAxis: { data: timeLabels },
                        series
                    });
                }
            }
        };

        const connect = () => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

            ws.onopen = () => {
                connected.value = true;
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                stats.value = data;
                syncDiskSelections(data.system?.disk || []);

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
                setTimeout(connect, 3000);
            };

            ws.onerror = () => {
                ws.close();
            };
        };

        const handleResize = () => {
            if (cpuChart) cpuChart.resize();
            if (gpuChart) gpuChart.resize();
            if (netChart) netChart.resize();
        };

        onMounted(() => {
            applyTheme();
            installAudioUnlockHandlers();
            connect();
            window.addEventListener('resize', handleResize);
        });

        onBeforeUnmount(() => {
            if (ws) ws.close();
            window.removeEventListener('resize', handleResize);
            if (audioUnlockCleanup) audioUnlockCleanup();
            stopAlarmSound();
            if (audioContext && audioContext.state !== 'closed') {
                audioContext.close();
            }
        });

        return {
            stats,
            connected,
            isDarkMode,
            toggleDarkMode,
            getBarColor,
            diskList,
            visibleDisks,
            showDiskMenu,
            toggleDiskMenu,
            closeDiskMenu,
            toggleDiskVisibility,
            selectAllDisks,
            clearDiskSelections,
            areAllDisksSelected,
            showMonitorModal,
            monitorForm,
            openMonitorModal,
            closeMonitorModal,
            saveMonitorSettings,
            isMonitorEnabled,
            getMonitorThreshold,
            toggleMonitor,
            activeAlertList,
            dismissAlert,
            dismissAllAlerts,
            audioStatus,
            armBrowserAudio,
            isAlarmSounding
        };
    }
}).mount('#app');
