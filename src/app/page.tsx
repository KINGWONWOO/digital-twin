'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// ── 타입 정의 ────────────────────────────────────────────────────

interface MachineData {
  id: string;
  machine_name: string;
  model_number: string;
  temperature: number;
  power_usage_kw: number;
  vibration_mms: number;
  operating_hours: number;
  oee_percent: number;
  specific_data: Record<string, unknown>;
  status: 'normal' | 'warning' | 'error' | 'offline';
  updated_at: string;
}

interface ErrorLogEntry {
  logId: string;
  machineId: string;
  machineName: string;
  status: 'warning' | 'error';
  temperature: number;
  vibration: number;
  power: number;
  timestamp: number;
  resolved: boolean;
  resolvedAt?: number;
  cause: string;
}

interface TimePoint {
  ts: number;
  productionRate: number;
  safetyScore: number;
}

interface CamState { x: number; y: number; yaw: number; }

// 공장 레벨 크기 (UE 월드 cm 단위) — 실제 레벨에 맞게 조정
const FACTORY = { minX: -5000, maxX: 5000, minY: -5000, maxY: 5000 };

// ── 상수 ─────────────────────────────────────────────────────────

const STATUS_COLOR: Record<MachineData['status'], string> = {
  normal: '#22c55e', warning: '#f59e0b', error: '#ef4444', offline: '#6b7280',
};
const STATUS_LABEL: Record<MachineData['status'], string> = {
  normal: '정상', warning: '경고', error: '오류', offline: '오프라인',
};

// ── 헬퍼 ─────────────────────────────────────────────────────────

const noise = (v: number, d: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number((v + Math.random() * d * 2 - d).toFixed(1))));

const makeCause = (m: { status?: string; temperature?: number; vibration_mms?: number }): string => {
  const parts: string[] = [];
  if ((m.temperature ?? 0) > 80) parts.push(`고온 ${m.temperature?.toFixed(1)}°C`);
  if ((m.vibration_mms ?? 0) > 4) parts.push(`진동 ${m.vibration_mms?.toFixed(1)} mm/s`);
  if (m.status === 'error') parts.push('긴급 정지');
  return parts.length ? parts.join(' · ') : m.status === 'warning' ? '경고 상태 감지' : '상태 변경';
};

const calcProduction = (ms: MachineData[]) => {
  const active = ms.filter(m => m.status !== 'offline');
  return active.length ? active.reduce((s, m) => s + m.oee_percent, 0) / active.length : 0;
};

const calcSafety = (ms: MachineData[]) => {
  let s = 100;
  ms.forEach(m => {
    if (m.status === 'error')   s -= 25;
    if (m.status === 'warning') s -= 10;
    if (m.temperature > 80)     s -= 8;
    if (m.vibration_mms > 4)    s -= 8;
  });
  return Math.max(0, Math.min(100, s));
};

const hms = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
};

// ── 미니맵 ───────────────────────────────────────────────────────

function Minimap({ cam, machines, selectedId }: { cam: CamState; machines: MachineData[]; selectedId: string | null }) {
  const W = 160, H = 110, PAD = 10;
  const iw = W - PAD * 2, ih = H - PAD * 2;

  const norm = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

  // UE: X=북, Y=동 → 화면: 북=위, 동=오른쪽
  const toSvg = (wx: number, wy: number) => ({
    x: PAD + norm(wy, FACTORY.minY, FACTORY.maxY) * iw,
    y: PAD + (1 - norm(wx, FACTORY.minX, FACTORY.maxX)) * ih,
  });

  const cam2d = toSvg(cam.x, cam.y);
  const rad   = (cam.yaw * Math.PI) / 180;
  const sz    = 7;
  const tip   = { x: cam2d.x + Math.sin(rad) * sz,           y: cam2d.y - Math.cos(rad) * sz };
  const lft   = { x: cam2d.x + Math.sin(rad - 2.35) * sz * 0.5, y: cam2d.y - Math.cos(rad - 2.35) * sz * 0.5 };
  const rgt   = { x: cam2d.x + Math.sin(rad + 2.35) * sz * 0.5, y: cam2d.y - Math.cos(rad + 2.35) * sz * 0.5 };

  return (
    <div style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(15,23,42,0.9)', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden', zIndex: 10, pointerEvents: 'none' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', padding: '3px 8px', borderBottom: '1px solid #1e293b' }}>MINIMAP</div>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* 공장 바닥 */}
        <rect x={PAD} y={PAD} width={iw} height={ih} fill="rgba(30,58,95,0.3)" stroke="#1e3a5f" strokeWidth={1} rx={2} />
        {/* 격자 (선택) */}
        <line x1={PAD + iw / 2} y1={PAD} x2={PAD + iw / 2} y2={PAD + ih} stroke="#1e293b" strokeWidth={0.5} />
        <line x1={PAD} y1={PAD + ih / 2} x2={PAD + iw} y2={PAD + ih / 2} stroke="#1e293b" strokeWidth={0.5} />
        {/* 머신 위치 (선택된 머신 강조) */}
        {machines.map((m, i) => {
          const angle = (i / machines.length) * Math.PI * 2;
          const r = Math.min(iw, ih) * 0.3;
          const mx = PAD + iw / 2 + Math.cos(angle) * r;
          const my = PAD + ih / 2 + Math.sin(angle) * r;
          const isSel = m.id === selectedId;
          return (
            <g key={m.id}>
              <circle cx={mx} cy={my} r={isSel ? 5 : 3} fill={isSel ? '#3b82f6' : '#334155'} stroke={isSel ? '#93c5fd' : '#475569'} strokeWidth={1} />
              {isSel && <circle cx={mx} cy={my} r={8} fill="none" stroke="#3b82f680" strokeWidth={1} />}
            </g>
          );
        })}
        {/* 카메라 위치/방향 (삼각형) */}
        <polygon
          points={`${tip.x},${tip.y} ${lft.x},${lft.y} ${rgt.x},${rgt.y}`}
          fill="#facc15" stroke="#fde68a" strokeWidth={0.8}
        />
      </svg>
    </div>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ height: 5, background: '#334155', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min((value / max) * 100, 100)}%`, background: color, borderRadius: 3, transition: 'width 0.4s' }} />
    </div>
  );
}

function Sparkline({ data, color, label, gid }: { data: number[]; color: string; label: string; gid: string }) {
  const H = 46; const W = 240;
  const toY = (v: number) => H - Math.max(0, Math.min(1, v / 100)) * H;
  const last = data[data.length - 1] ?? 0;

  if (data.length < 2) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>—</span>
        </div>
        <div style={{ height: H, background: '#0f172a', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#334155' }}>수집 중...</div>
      </div>
    );
  }

  const pts = data.map((v, i) => `${((i / (data.length - 1)) * W).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const area = `0,${H} ${pts} ${W},${H}`;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{last.toFixed(1)}<span style={{ fontSize: 10, color: '#475569' }}>%</span></span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={((data.length - 1) / (data.length - 1) * W).toFixed(1)} cy={toY(last).toFixed(1)} r="3" fill={color} />
      </svg>
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────

export default function DigitalTwinControlDashboard() {
  const [machines, setMachines]               = useState<MachineData[]>([]);
  const [log, setLog]                         = useState('시스템 초기화 중...');
  const [online, setOnline]                   = useState(false);
  const [selectedMachine, setSelectedMachine] = useState<MachineData | null>(null);
  const [isSimulating, setIsSimulating]       = useState(false);
  const [errorLog, setErrorLog]               = useState<ErrorLogEntry[]>([]);
  const [showErrPanel, setShowErrPanel]       = useState(false);
  const [errTab, setErrTab]                   = useState<'active' | 'history'>('active');
  const [timeSeries, setTimeSeries]           = useState<TimePoint[]>([]);

  const [camState, setCamState] = useState<CamState>({ x: 0, y: 0, yaw: 0 });

  const machinesRef     = useRef<MachineData[]>([]);
  const lastTsRef       = useRef<number>(0);
  const prevStatusRef   = useRef<Record<string, MachineData['status']>>({});
  const iframeRef       = useRef<HTMLIFrameElement>(null);

  useEffect(() => { machinesRef.current = machines; }, [machines]);

  // 선택 기계 변경 → Supabase에 저장 (UE가 폴링) + PS 데이터채널 (보조)
  const selectMachine = useCallback((m: MachineData | null) => {
    setSelectedMachine(m);
    // Supabase relay: UE가 factory_selection 테이블을 폴링해서 카메라 이동
    // upsert: 행이 없으면 INSERT, 있으면 UPDATE (update만 쓰면 행 없을 때 무음 실패)
    supabase.from('factory_selection')
      .upsert({ id: 'current', machine_id: m?.id ?? null }, { onConflict: 'id' })
      .then(({ error }) => {
        if (error) console.error('[DigitalTwin] factory_selection 업데이트 실패:', error);
        else console.log('[DigitalTwin] factory_selection →', m?.id ?? null);
      });
    // PS 데이터채널 (보조 경로)
    if (m && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'machineSelect', id: m.id }, '*');
    }
    fetch('/api/machine-select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: m?.id ?? null }),
    }).catch(() => {});
  }, []);

  // UE 클릭 폴링 (500ms)
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const data = await fetch('/api/machine-click').then(r => r.json());
        if (data?.id && data.ts > lastTsRef.current) {
          lastTsRef.current = data.ts;
          const found = machinesRef.current.find(m => m.id === data.id);
          if (found) selectMachine(found);
        }
      } catch { /* 무시 */ }
    }, 500);
    return () => clearInterval(iv);
  }, [selectMachine]);

  // camera_state 실시간 구독
  useEffect(() => {
    supabase.from('camera_state').select('x,y,yaw').eq('id', 'current').single()
      .then(({ data }) => { if (data) setCamState(data as CamState); });

    const ch = supabase.channel('rt-cam')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'camera_state' }, ({ new: n }) => {
        const s = n as CamState;
        setCamState({ x: s.x ?? 0, y: s.y ?? 0, yaw: s.yaw ?? 0 });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // 그래프 샘플링 (10초 주기)
  useEffect(() => {
    const iv = setInterval(() => {
      const ms = machinesRef.current;
      if (!ms.length) return;
      setTimeSeries(prev => [...prev, {
        ts: Date.now(),
        productionRate: calcProduction(ms),
        safetyScore: calcSafety(ms),
      }].slice(-30));
    }, 10_000);
    return () => clearInterval(iv);
  }, []);

  // Supabase 구독
  useEffect(() => {
    fetchMachines();
    const ch = supabase.channel('rt-factory')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'factory_machines' }, payload => {
        const next = payload.new as Partial<MachineData>;
        if (!next?.id) return;

        setMachines(prev => prev.map(m => m.id === next.id ? { ...m, ...next } : m));
        setSelectedMachine(prev => prev?.id === next.id ? { ...prev, ...next } as MachineData : prev);

        // 오류 로그: 상태 전환 감지
        const prev = prevStatusRef.current[next.id];
        const curr = next.status;
        if (curr && curr !== prev) {
          prevStatusRef.current[next.id] = curr;
          const existing = machinesRef.current.find(m => m.id === next.id);

          if (curr === 'warning' || curr === 'error') {
            setErrorLog(log => [{
              logId: `${next.id}-${Date.now()}`,
              machineId:    next.id!,
              machineName:  existing?.machine_name ?? next.id!,
              status:       curr,
              temperature:  next.temperature    ?? existing?.temperature    ?? 0,
              vibration:    next.vibration_mms  ?? existing?.vibration_mms  ?? 0,
              power:        next.power_usage_kw ?? existing?.power_usage_kw ?? 0,
              timestamp: Date.now(),
              resolved: false,
              cause: makeCause(next),
            }, ...log]);
          }

          if ((prev === 'warning' || prev === 'error') && curr === 'normal') {
            setErrorLog(log => log.map(e =>
              e.machineId === next.id && !e.resolved
                ? { ...e, resolved: true, resolvedAt: Date.now() }
                : e
            ));
          }
        }
      })
      .subscribe(s => {
        setOnline(s === 'SUBSCRIBED');
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setLog('실시간 채널 재연결 시도 중...');
      });
    return () => { supabase.removeChannel(ch); };
  }, []);

  // 자동 시뮬레이션
  useEffect(() => {
    if (!isSimulating) { setLog('시뮬레이션 중지됨.'); return; }
    setLog('자동 센서 시뮬레이션 가동 중... (3초 주기)');
    const iv = setInterval(() => {
      machinesRef.current.forEach(async m => {
        if (m.status === 'error' || m.status === 'offline') return;
        const nTemp  = noise(m.temperature,    0.5, 20, 100);
        const nPower = noise(m.power_usage_kw, 0.2,  0,  30);
        const nVib   = noise(m.vibration_mms,  0.1,  0,  10);
        const nOee   = noise(m.oee_percent,    0.2,  0, 100);
        const ns     = m.status === 'normal' && (nTemp > 75 || nVib > 4.0) ? 'warning' : m.status;
        await supabase.from('factory_machines')
          .update({ temperature: nTemp, power_usage_kw: nPower, vibration_mms: nVib, oee_percent: nOee, status: ns })
          .eq('id', m.id);
      });
    }, 3000);
    return () => clearInterval(iv);
  }, [isSimulating]);

  const fetchMachines = async () => {
    const { data, error } = await supabase.from('factory_machines').select('*').order('id', { ascending: true });
    if (error) { setLog(`조회 오류: ${error.message}`); return; }
    if (!data?.length) { setLog('조회 결과 없음'); return; }

    const typed = data as MachineData[];
    setMachines(typed);
    setLog(`데이터 적재 완료 (${typed.length}건)`);

    // 초기 상태 캐시 + 이미 오류인 기계 로그 등록
    const init: ErrorLogEntry[] = [];
    typed.forEach(m => {
      prevStatusRef.current[m.id] = m.status;
      if (m.status === 'warning' || m.status === 'error') {
        init.push({ logId: `${m.id}-init`, machineId: m.id, machineName: m.machine_name, status: m.status, temperature: m.temperature, vibration: m.vibration_mms, power: m.power_usage_kw, timestamp: Date.now(), resolved: false, cause: makeCause(m) });
      }
    });
    if (init.length) setErrorLog(init);

    setTimeSeries([{ ts: Date.now(), productionRate: calcProduction(typed), safetyScore: calcSafety(typed) }]);
  };

  const simulateManual = async (id: string, status: MachineData['status'], temp: number, power: number, vib: number) => {
    const { error } = await supabase.from('factory_machines')
      .update({ status, temperature: temp, power_usage_kw: power, vibration_mms: vib }).eq('id', id);
    if (error) { setLog(`제어 오류: ${error.message}`); return; }
    const upd = { status, temperature: temp, power_usage_kw: power, vibration_mms: vib };
    setMachines(prev => prev.map(m => m.id === id ? { ...m, ...upd } : m));
    setSelectedMachine(prev => prev?.id === id ? { ...prev, ...upd } as MachineData : prev);
    setLog(`제어 완료: ${id} → ${status}`);
  };

  // ── 파생 값 ──────────────────────────────────────────────────────
  const activeErrors    = errorLog.filter(e => !e.resolved);
  const displayedLog    = errTab === 'active'
    ? activeErrors
    : [...errorLog].sort((a, b) => b.timestamp - a.timestamp);
  const productionData  = timeSeries.map(p => p.productionRate);
  const safetyData      = timeSeries.map(p => p.safetyScore);
  const latestSafety    = safetyData[safetyData.length - 1] ?? 100;
  const safetyColor     = latestSafety < 60 ? '#ef4444' : latestSafety < 80 ? '#f59e0b' : '#22c55e';
  const fabRight        = selectedMachine ? 344 : 24;  // 오른쪽 패널 열릴 때 FAB 이동

  // ── 렌더 ──────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#0f172a', fontFamily: 'system-ui, sans-serif' }}>

      {/* ═══════════ 왼쪽 패널 ═══════════ */}
      <aside style={{ width: 272, minWidth: 272, background: '#1e293b', display: 'flex', flexDirection: 'column', borderRight: '1px solid #334155' }}>

        {/* 헤더 */}
        <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #334155' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.1em', marginBottom: 2 }}>DIGITAL TWIN</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', marginBottom: 10 }}>공장 설비 관제</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: online ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: online ? '#22c55e' : '#ef4444', boxShadow: online ? '0 0 5px #22c55e' : 'none' }} />
              {online ? 'DB 연결됨' : 'DB 끊김'}
            </div>
            <button
              onClick={() => setIsSimulating(p => !p)}
              style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 10, border: 'none', cursor: 'pointer', background: isSimulating ? '#3b82f6' : '#334155', color: isSimulating ? '#fff' : '#64748b', transition: 'all 0.18s' }}
            >
              {isSimulating ? '⏸ 시뮬 끄기' : '▶ 시뮬 켜기'}
            </button>
          </div>
        </div>

        {/* 기계 목록 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {machines.map(m => {
            const isSel = selectedMachine?.id === m.id;
            const c = STATUS_COLOR[m.status];
            return (
              <div key={m.id} onClick={() => selectMachine(m)}
                style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 3, cursor: 'pointer', background: isSel ? '#1e3a5f' : 'transparent', border: `1px solid ${isSel ? '#3b82f680' : 'transparent'}`, transition: 'all 0.12s' }}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = '#2d3f55'; }}
                onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{m.machine_name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: c, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: c, boxShadow: m.status !== 'offline' && m.status !== 'normal' ? `0 0 5px ${c}` : 'none' }} />
                    {STATUS_LABEL[m.status]}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <span style={{ fontSize: 11, color: '#475569' }}>온도 <b style={{ color: '#64748b', fontWeight: 600 }}>{m.temperature}°</b></span>
                  <span style={{ fontSize: 11, color: '#475569' }}>OEE <b style={{ color: '#64748b', fontWeight: 600 }}>{m.oee_percent}%</b></span>
                </div>
              </div>
            );
          })}
        </div>

        {/* 실시간 현황 그래프 */}
        <div style={{ padding: '10px 12px 6px', borderTop: '1px solid #334155', background: '#0f172a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em' }}>실시간 현황</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: safetyColor }}>
              안전 {latestSafety < 60 ? '위험' : latestSafety < 80 ? '주의' : '양호'}
            </span>
          </div>
          <Sparkline data={productionData} color="#3b82f6"   label="생산률 (OEE)" gid="g-prod" />
          <Sparkline data={safetyData}     color={safetyColor} label="안전 지수"    gid="g-safe" />
        </div>

        {/* 로그 줄 */}
        <div style={{ padding: '5px 10px', borderTop: '1px solid #1e293b', fontSize: 10, color: '#334155', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {log}
        </div>
      </aside>

      {/* ═══════════ 중앙: 픽셀 스트리밍 ═══════════ */}
      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <iframe ref={iframeRef} src={`${process.env.NEXT_PUBLIC_PIXEL_STREAM_URL}?HoveringMouse=true`} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} allow="autoplay; fullscreen" />

        {/* 조작 안내 (뷰포트 왼쪽 하단) */}
        <div style={{ position: 'absolute', bottom: 16, left: 16, background: 'rgba(15,23,42,0.82)', borderRadius: 8, padding: '8px 12px', border: '1px solid #334155', pointerEvents: 'none', zIndex: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', marginBottom: 6 }}>조작 안내</div>
          {([
            ['우클릭 드래그', '화면 회전'],
            ['W / S', '앞 / 뒤 이동'],
            ['A / D', '좌 / 우 이동'],
            ['E / Q', '위 / 아래 이동'],
            ['왼쪽 클릭', '머신 선택'],
          ] as [string, string][]).map(([key, desc]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', minWidth: 88, fontFamily: 'monospace' }}>{key}</span>
              <span style={{ fontSize: 10, color: '#475569' }}>{desc}</span>
            </div>
          ))}
        </div>
      </main>

      {/* ═══════════ 오른쪽 패널: 상세 정보 ═══════════ */}
      <aside style={{ width: selectedMachine ? 318 : 0, minWidth: selectedMachine ? 318 : 0, background: '#1e293b', borderLeft: '1px solid #334155', overflow: 'hidden', transition: 'width 0.22s ease, min-width 0.22s ease', display: 'flex', flexDirection: 'column' }}>
        {selectedMachine && (
          <>
            {/* 헤더 */}
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #334155', background: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 10, color: '#334155', marginBottom: 2 }}>{selectedMachine.model_number}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#f1f5f9' }}>{selectedMachine.machine_name}</div>
                </div>
                <button onClick={() => selectMachine(null)} style={{ background: 'none', border: 'none', color: '#475569', fontSize: 20, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>×</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[selectedMachine.status], boxShadow: `0 0 6px ${STATUS_COLOR[selectedMachine.status]}` }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: STATUS_COLOR[selectedMachine.status], textTransform: 'uppercase' }}>{selectedMachine.status}</span>
                <span style={{ fontSize: 10, color: '#334155', marginLeft: 'auto' }}>{selectedMachine.operating_hours.toLocaleString()}h 가동</span>
              </div>
            </div>

            {/* 본문 */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>

              {/* 텔레메트리 */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', marginBottom: 10 }}>TELEMETRY</div>
              {[
                { label: '온도',      value: selectedMachine.temperature,    unit: '°C',  max: 100, color: selectedMachine.temperature > 80 ? '#ef4444' : selectedMachine.temperature > 50 ? '#f59e0b' : '#3b82f6' },
                { label: '전력 소비', value: selectedMachine.power_usage_kw, unit: 'kW',  max: 30,  color: '#8b5cf6' },
                { label: '진동',      value: selectedMachine.vibration_mms,  unit: 'mm/s',max: 10,  color: selectedMachine.vibration_mms > 3 ? '#ef4444' : '#10b981' },
                { label: 'OEE',       value: selectedMachine.oee_percent,    unit: '%',   max: 100, color: selectedMachine.oee_percent < 70 ? '#f59e0b' : '#22c55e' },
              ].map(item => (
                <div key={item.label} style={{ marginBottom: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 12, color: '#64748b' }}>{item.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>{item.value} <span style={{ fontSize: 10, color: '#475569' }}>{item.unit}</span></span>
                  </div>
                  <Bar value={item.value} max={item.max} color={item.color} />
                </div>
              ))}

              {/* 특화 데이터 */}
              {Object.keys(selectedMachine.specific_data).length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', margin: '16px 0 10px' }}>SPECIFIC DATA</div>
                  <div style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px', border: '1px solid #1e293b' }}>
                    {Object.entries(selectedMachine.specific_data).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #1a2535' }}>
                        <span style={{ fontSize: 11, color: '#475569', textTransform: 'capitalize' }}>{k.replace(/_/g, ' ')}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* 수동 제어 */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', margin: '16px 0 10px' }}>MANUAL OVERRIDE</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button onClick={() => simulateManual(selectedMachine.id, 'normal',  25.5,  4.2, 0.5)} style={{ padding: '9px', background: '#14532d', color: '#22c55e', border: '1px solid #166534', borderRadius: 7, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>정상 가동 복구</button>
                <button onClick={() => simulateManual(selectedMachine.id, 'warning', 78.5, 15.4, 4.5)} style={{ padding: '9px', background: '#451a03', color: '#f59e0b', border: '1px solid #78350f', borderRadius: 7, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>부하 발생 (Warning)</button>
                <button onClick={() => simulateManual(selectedMachine.id, 'error',  110.2,  0.0,12.5)} style={{ padding: '9px', background: '#450a0a', color: '#ef4444', border: '1px solid #7f1d1d', borderRadius: 7, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>긴급 정지 (Error)</button>
              </div>

              <div style={{ marginTop: 12, fontSize: 10, color: '#1e293b', textAlign: 'right', fontFamily: 'monospace' }}>
                sync {new Date(selectedMachine.updated_at).toLocaleTimeString()}
              </div>
            </div>
          </>
        )}
      </aside>

      {/* ═══════════ FAB: 오류 알림 버튼 ═══════════ */}
      <button
        onClick={() => setShowErrPanel(p => !p)}
        title="오류 로그"
        style={{
          position: 'fixed', bottom: 24, right: fabRight,
          width: 52, height: 52, borderRadius: '50%',
          background: activeErrors.length ? '#7f1d1d' : '#1e293b',
          border: `2px solid ${activeErrors.length ? '#ef4444' : '#334155'}`,
          color: activeErrors.length ? '#ef4444' : '#475569',
          fontSize: 20, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: activeErrors.length ? '0 0 18px #ef444450' : '0 4px 12px #00000060',
          transition: 'all 0.22s',
          zIndex: 200,
        }}
      >
        {activeErrors.length > 0 && (
          <span style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: '#fff', borderRadius: '50%', width: 18, height: 18, fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #0f172a' }}>
            {activeErrors.length > 9 ? '9+' : activeErrors.length}
          </span>
        )}
        <span style={{ fontSize: 20 }}>⚠</span>
      </button>

      {/* ═══════════ 오류 로그 패널 ═══════════ */}
      {showErrPanel && (
        <div style={{ position: 'fixed', bottom: 88, right: fabRight, width: 370, maxHeight: '62vh', background: '#1e293b', borderRadius: 14, border: '1px solid #334155', boxShadow: '0 20px 50px #00000080', display: 'flex', flexDirection: 'column', zIndex: 199 }}>

          {/* 패널 헤더 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #334155' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>오류 로그</span>
            <button onClick={() => setShowErrPanel(false)} style={{ background: 'none', border: 'none', color: '#475569', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>

          {/* 탭 */}
          <div style={{ display: 'flex', padding: '0 10px', borderBottom: '1px solid #334155' }}>
            {(['active', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setErrTab(tab)}
                style={{ padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: errTab === tab ? '#f1f5f9' : '#475569', borderBottom: `2px solid ${errTab === tab ? '#3b82f6' : 'transparent'}`, transition: 'all 0.14s' }}
              >
                {tab === 'active' ? `현재 오류 (${activeErrors.length})` : `전체 기록 (${errorLog.length})`}
              </button>
            ))}
          </div>

          {/* 항목 목록 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
            {displayedLog.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#334155' }}>
                {errTab === 'active' ? '현재 활성 오류 없음' : '기록된 오류 없음'}
              </div>
            ) : displayedLog.map(e => (
              <div key={e.logId}
                style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 4, background: '#0f172a', border: `1px solid ${e.status === 'error' ? '#7f1d1d' : '#78350f'}` }}
              >
                {/* 기계명 + 상태 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>{e.machineName}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: e.status === 'error' ? '#ef4444' : '#f59e0b' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: e.status === 'error' ? '#ef4444' : '#f59e0b' }} />
                    {e.status === 'error' ? '오류' : '경고'}
                    {e.resolved && <span style={{ color: '#22c55e', marginLeft: 4, fontWeight: 600 }}>해소</span>}
                  </span>
                </div>
                {/* 위치 + 시각 */}
                <div style={{ fontSize: 11, color: '#475569', marginBottom: 3 }}>
                  ID {e.machineId} &nbsp;·&nbsp; 발생 {hms(e.timestamp)}
                  {e.resolved && e.resolvedAt && <span style={{ color: '#22c55e' }}> → {hms(e.resolvedAt)} 해소</span>}
                </div>
                {/* 원인 */}
                <div style={{ fontSize: 11, color: e.status === 'error' ? '#fca5a5' : '#fcd34d', marginBottom: 5, fontWeight: 600 }}>
                  {e.cause}
                </div>
                {/* 수치 */}
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#475569' }}>
                  <span>온도 {e.temperature.toFixed(1)}°C</span>
                  <span>진동 {e.vibration.toFixed(1)} mm/s</span>
                  <span>전력 {e.power.toFixed(1)} kW</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
