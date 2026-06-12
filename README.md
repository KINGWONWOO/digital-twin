# 공장 디지털 트윈 (Factory Digital Twin)

> UE5 Pixel Streaming + Supabase 실시간 DB + Next.js 웹 대시보드로 구성된  
> **이기종 멀티-호스트 디지털 트윈 시스템**

UE5(Windows)에서 렌더링된 3D 공장 화면을 WebRTC로 브라우저에 스트리밍하면서,  
웹 UI의 설비 버튼 클릭 한 번으로 UE5 카메라가 해당 설비 위치로 이동합니다.  
Supabase Realtime으로 온도·진동·전력 등 센서 데이터가 1초 미만 지연으로 갱신됩니다.

---

## 목차

1. [시스템 개요](#1-시스템-개요)
2. [아키텍처](#2-아키텍처)
3. [주요 기능](#3-주요-기능)
4. [기술 스택](#4-기술-스택)
5. [프로젝트 구조](#5-프로젝트-구조)
6. [구현 방법](#6-구현-방법)
   - [6-1. Supabase 데이터베이스 설정](#6-1-supabase-데이터베이스-설정)
   - [6-2. UE5 C++ — MachineActor](#6-2-ue5-c--machineactor)
   - [6-3. UE5 C++ — PlayerController](#6-3-ue5-c--playercontroller)
   - [6-4. Next.js 웹 대시보드](#6-4-nextjs-웹-대시보드)
   - [6-5. Pixel Streaming 연동](#6-5-pixel-streaming-연동)
7. [트러블슈팅](#7-트러블슈팅)
8. [개선사항 및 향후 계획](#8-개선사항-및-향후-계획)
9. [실행 방법](#9-실행-방법)

---

## 1. 시스템 개요

이 프로젝트는 UE5로 제작된 가상 공장 환경을 웹 브라우저에서 실시간으로 제어·모니터링하는 **디지털 트윈** 시스템입니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                        브라우저 (Linux)                          │
│  ┌─────────────────────────┐   ┌──────────────────────────────┐  │
│  │   Next.js 대시보드       │   │  Pixel Streaming iframe      │  │
│  │  ┌──────────────────┐   │   │  (UE5 3D 뷰포트 · WebRTC)    │  │
│  │  │ 설비 목록 사이드바 │   │   │                              │  │
│  │  │ 텔레메트리 패널   │   │   │   [CNC A]  [Robot B]         │  │
│  │  │ 오류 로그 패널   │   │   │        공장 3D 씬             │  │
│  │  │ 실시간 스파크라인 │   │   │                              │  │
│  │  └──────────────────┘   │   └──────────────────────────────┘  │
│  └───────────┬─────────────┘                                     │
└──────────────┼────────────────────────────────────────────────── ┘
               │  Supabase REST + Realtime WebSocket
               ▼
┌─────────────────────────────────────┐
│             Supabase                │
│  ┌────────────────────────────┐     │
│  │ factory_machines           │ ◄───┼──── UE5 가 2초마다 폴링 후 갱신
│  │  id, status, temperature…  │     │
│  ├────────────────────────────┤     │
│  │ factory_selection          │ ◄───┼──── 웹에서 설비 클릭 시 UPSERT
│  │  id='current', machine_id  │     │
│  ├────────────────────────────┤     │
│  │ camera_state               │ ◄───┼──── UE5 가 0.5초마다 PATCH
│  │  id='current', x, y, yaw  │     │
│  └────────────────────────────┘     │
└──────────────┬──────────────────────┘
               │  REST API (GET/PATCH)
               ▼
┌──────────────────────────────────────────────────────┐
│                   UE5 (Windows)                       │
│  MachineActor × N  ──▶ 상태 폴링 / 발광 색상 변경    │
│  PlayerController  ──▶ 카메라 이동 / 위치 전송        │
│  Pixel Streaming 2 ──▶ 브라우저로 WebRTC 영상 스트림  │
└──────────────────────────────────────────────────────┘
```

### 핵심 설계 결정: Supabase를 릴레이로 사용

UE5(Windows)와 Next.js(Linux)는 **서로 다른 물리 머신**에서 실행되기 때문에  
`localhost` 직접 통신이 불가능합니다. 이를 해결하기 위해 **Supabase를 중계 서버**로 씁니다.

| 방향 | 방법 | 지연 |
|---|---|---|
| 웹 → UE (설비 선택) | 웹 → `factory_selection` UPSERT → UE 1초 폴링 | ~1 s |
| UE → 웹 (카메라 위치) | UE → `camera_state` PATCH 0.5초마다 → 웹 Realtime 구독 | ~0.5 s |
| DB → 웹 (센서 데이터) | Supabase Realtime WebSocket push | <300 ms |

---

## 2. 아키텍처

### 통신 흐름 상세

```
[웹 버튼 클릭] ──upsert──▶ factory_selection.machine_id = 'cnc-01'
                                │
                      UE5 MachineActor(cnc-01) 폴링 감지
                                │
                      MoveViewportToCamera() 호출
                                │
                      Pawn.SetActorLocationAndRotation(CameraActor 위치)
                                │
                      UE5 뷰포트 카메라 이동 ✅
                                │
                      camera_state PATCH (x, y, yaw)
                                │
                      웹 Realtime 구독 → 미니맵 업데이트
```

---

## 3. 주요 기능

| 기능 | 설명 |
|---|---|
| 실시간 설비 모니터링 | 온도·진동·전력·OEE를 Supabase Realtime으로 갱신 |
| 카메라 이동 | 웹 버튼 클릭 → UE5 카메라가 해당 설비 위치로 즉시 이동 |
| 설비 상태 발광 | 정상(발광 없음) / 경고(주황 펄스 1.5 Hz) / 오류(빨간 깜빡임 5 Hz) |
| 자유 시점 이동 | WASD + 우클릭 드래그로 3D 뷰포트 자유 이동 |
| 오류 로그 패널 | 상태 전환 이력, 현재 활성 오류 / 전체 기록 탭 |
| 자동 시뮬레이션 | 3초마다 센서값에 노이즈 추가 → 실제 공장처럼 변동 |
| 수동 제어 | 설비별 정상/경고/오류 강제 설정 (Manual Override) |
| 미니맵 | 현재 카메라 위치·방향 SVG 오버레이 |

---

## 4. 기술 스택

| 영역 | 기술 |
|---|---|
| 3D 엔진 | Unreal Engine 5.6 / 5.7 (C++) |
| 스트리밍 | Epic Pixel Streaming 2 (PS2 / WebRTC) |
| 웹 프레임워크 | Next.js 16 (App Router, TypeScript) |
| UI | React 19, 인라인 스타일, Tailwind CSS 4 |
| 데이터베이스 | Supabase (PostgreSQL + Realtime) |
| 배포 환경 | Google Cloud Workstations, Cloudflare Tunnel |

---

## 5. 프로젝트 구조

```
digitaltwin/
├── src/
│   ├── app/
│   │   ├── page.tsx                        # 메인 대시보드 컴포넌트 (약 650줄)
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── api/
│   │       ├── machine-click/route.ts      # UE→웹 클릭 이벤트 인메모리 릴레이
│   │       └── machine-select/route.ts     # 웹→UE 선택 릴레이 (레거시)
│   ├── lib/
│   │   └── supabaseClient.ts               # Supabase 싱글톤 초기화
│   └── unreal/
│       └── FactoryEnvironmentCollect/
│           ├── FactoryEnvironmentCollect.Build.cs
│           ├── Config/
│           │   ├── DefaultDigitalTwin.ini.example
│           │   └── DefaultInput.ini        # WASD / Turn / LookUp 축 정의
│           ├── Public/
│           │   ├── MachineActor.h
│           │   ├── DigitalTwinPlayerController.h
│           │   ├── DigitalTwinGameMode.h
│           │   └── DigitalTwinCameraActor.h
│           └── Private/
│               ├── MachineActor.cpp
│               ├── DigitalTwinPlayerController.cpp
│               ├── DigitalTwinGameMode.cpp
│               └── DigitalTwinCameraActor.cpp
├── PixelStreamingInfrastructure/           # ⚠ .gitignore 제외 — 별도 clone 필요
├── next.config.ts
├── package.json
└── README.md
```

---

## 6. 구현 방법

### 6-1. Supabase 데이터베이스 설정

Supabase 대시보드 → **SQL Editor** → New query 에서 실행합니다.

```sql
-- ① 설비 센서 데이터 테이블
CREATE TABLE factory_machines (
  id              TEXT PRIMARY KEY,
  machine_name    TEXT NOT NULL,
  model_number    TEXT,
  status          TEXT DEFAULT 'normal' CHECK (status IN ('normal','warning','error','offline')),
  temperature     FLOAT8 DEFAULT 25.0,
  power_usage_kw  FLOAT8 DEFAULT 5.0,
  vibration_mms   FLOAT8 DEFAULT 0.5,
  operating_hours INT    DEFAULT 0,
  oee_percent     FLOAT8 DEFAULT 85.0,
  specific_data   JSONB  DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 자동 updated_at 트리거
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON factory_machines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Realtime 활성화 (★ 이 줄 없으면 구독 이벤트가 전달되지 않음)
ALTER TABLE factory_machines REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE factory_machines;

-- RLS 정책
ALTER TABLE factory_machines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select" ON factory_machines FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update" ON factory_machines FOR UPDATE TO anon
  USING (true) WITH CHECK (status IN ('normal','warning','error','offline'));

-- 샘플 데이터 (설비 3대)
INSERT INTO factory_machines VALUES
  ('cnc-01',      'CNC 머시닝 센터', 'DMG-MORI-NLX2500', 'normal',  24.5, 12.3, 0.8, 4320, 87.2, '{"spindle_speed":"3200rpm"}', now()),
  ('robot-02',    '용접 로봇 #2',   'FANUC-ARC-M10iA',  'normal',  31.2,  8.7, 1.2, 2180, 91.5, '{"arm_reach":"1.4m"}',        now()),
  ('conveyor-03', '컨베이어 라인 3', 'HYTROL-E24',       'normal',  22.1,  4.2, 0.4, 8760, 78.9, '{"belt_speed":"0.5m/s"}',     now());

-- ② 웹→UE 카메라 릴레이 테이블
CREATE TABLE factory_selection (
  id TEXT PRIMARY KEY, machine_id TEXT
);
INSERT INTO factory_selection VALUES ('current', null);
ALTER TABLE factory_selection DISABLE ROW LEVEL SECURITY;

-- ③ UE→웹 카메라 위치 테이블 (미니맵용)
CREATE TABLE camera_state (
  id TEXT PRIMARY KEY, x FLOAT8 DEFAULT 0, y FLOAT8 DEFAULT 0, yaw FLOAT8 DEFAULT 0
);
INSERT INTO camera_state VALUES ('current', 0, 0, 0);
ALTER TABLE camera_state DISABLE ROW LEVEL SECURITY;
```

---

### 6-2. UE5 C++ — MachineActor

각 설비 3D 오브젝트에 붙는 C++ 액터입니다.

#### 헤더 (`MachineActor.h`)

```cpp
UCLASS()
class FACTORYENVIRONMENTCOLLECT_API AMachineActor : public AActor
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Digital Twin Config")
    FString MachineID;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Digital Twin Config")
    ACameraActor* MachineCamera = nullptr;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Digital Twin Components")
    UMeshComponent* MeshComponent;

    UPROPERTY(BlueprintReadOnly, Category = "Digital Twin Materials")
    UMaterialInstanceDynamic* DynamicMaterialInstance;

    void MoveViewportToCamera();
    bool bIsSelected = false;

protected:
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaTime) override;

private:
    void FetchMachineStatus();
    void PollSelectionState();
    void OnStatusResponseReceived(FHttpRequestPtr, FHttpResponsePtr, bool);
    void OnSelectionResponseReceived(FHttpRequestPtr, FHttpResponsePtr, bool);

    FString CurrentStatus = TEXT("normal");
    FTimerHandle PollingTimerHandle;
    FTimerHandle SelectionTimerHandle;
    float  CurrentInterval    = 2.0f;
    int32  ConsecutiveFailures = 0;
    FString SupabaseUrl;
    FString SupabaseAnonKey;
};
```

#### `Tick` — 발광 색상 실시간 제어

머티리얼의 `StatusColor` Vector Parameter를 Emissive Color에 연결해야 작동합니다.

```cpp
void AMachineActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    if (!DynamicMaterialInstance) return;

    const float T = GetWorld()->GetTimeSeconds();
    FLinearColor Emissive(0.f, 0.f, 0.f);

    if (CurrentStatus == TEXT("error"))
    {
        const float Blink = FMath::Abs(FMath::Sin(T * 5.0f * PI));
        Emissive = FLinearColor(Blink * 3.0f, 0.f, 0.f);       // 빨간 깜빡임 5Hz
    }
    else if (CurrentStatus == TEXT("warning"))
    {
        const float Blink = 0.5f + 0.5f * FMath::Sin(T * 1.5f * PI);
        Emissive = FLinearColor(Blink * 2.0f, Blink * 0.8f, 0.f); // 주황 펄스 1.5Hz
    }
    else if (bIsSelected)
    {
        const float Pulse = 0.6f + 0.4f * FMath::Sin(T * 2.0f);
        Emissive = FLinearColor(0.f, Pulse * 0.5f, Pulse * 1.8f); // 파란 펄스
    }

    DynamicMaterialInstance->SetVectorParameterValue(TEXT("StatusColor"), Emissive);
}
```

#### Supabase 상태 폴링 (지수 백오프 포함)

```cpp
void AMachineActor::FetchMachineStatus()
{
    FHttpRequestRef Request = FHttpModule::Get().CreateRequest();
    Request->OnProcessRequestComplete().BindUObject(
        this, &AMachineActor::OnStatusResponseReceived);
    Request->SetURL(FString::Printf(
        TEXT("%s/rest/v1/factory_machines?id=eq.%s&select=*"),
        *SupabaseUrl, *MachineID));
    Request->SetVerb(TEXT("GET"));
    Request->SetHeader(TEXT("apikey"), SupabaseAnonKey);
    Request->SetHeader(TEXT("Authorization"),
        FString::Printf(TEXT("Bearer %s"), *SupabaseAnonKey));
    Request->SetTimeout(5.0f);
    Request->ProcessRequest();
}

void AMachineActor::OnStatusResponseReceived(
    FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful)
{
    if (!bWasSuccessful || !Response.IsValid())
    {
        ConsecutiveFailures++;
        CurrentInterval = FMath::Min(CurrentInterval * 2.0f, 30.0f); // 지수 백오프
        GetWorldTimerManager().SetTimer(PollingTimerHandle,
            this, &AMachineActor::FetchMachineStatus, CurrentInterval, true);
        return;
    }
    if (Response->GetResponseCode() != 200) return;
    if (ConsecutiveFailures > 0) { ConsecutiveFailures = 0; CurrentInterval = 2.0f; }

    TArray<TSharedPtr<FJsonValue>> JsonArray;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());
    if (FJsonSerializer::Deserialize(Reader, JsonArray) && JsonArray.Num() > 0)
    {
        const TSharedPtr<FJsonObject> Obj = JsonArray[0]->AsObject();
        if (Obj.IsValid()) Obj->TryGetStringField(TEXT("status"), CurrentStatus);
    }
}
```

#### `factory_selection` 폴링 → 카메라 이동

```cpp
void AMachineActor::OnSelectionResponseReceived(
    FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful)
{
    if (!bWasSuccessful || !Response.IsValid()
        || Response->GetResponseCode() != 200) return;

    TArray<TSharedPtr<FJsonValue>> JsonArray;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());
    if (!FJsonSerializer::Deserialize(Reader, JsonArray) || JsonArray.Num() == 0) return;

    FString SelId;
    JsonArray[0]->AsObject()->TryGetStringField(TEXT("machine_id"), SelId);

    const bool bNewSelected = (SelId == MachineID);
    if (bNewSelected && !bIsSelected)
        MoveViewportToCamera();  // 선택 전환 시에만 이동 (중복 방지)
    bIsSelected = bNewSelected;
}
```

#### 카메라 즉시 이동

```cpp
void AMachineActor::MoveViewportToCamera()
{
    if (!MachineCamera)
    {
        UE_LOG(LogTemp, Warning,
            TEXT("[DigitalTwin] %s: MachineCamera 미설정"), *MachineID);
        return;
    }
    APlayerController* PC = GetWorld()->GetFirstPlayerController();
    APawn* Pawn = PC ? PC->GetPawn() : nullptr;
    if (!Pawn) return;

    Pawn->SetActorLocationAndRotation(
        MachineCamera->GetActorLocation(),
        MachineCamera->GetActorRotation());
    PC->SetControlRotation(MachineCamera->GetActorRotation());
    UE_LOG(LogTemp, Log, TEXT("[DigitalTwin] %s → 즉시 이동"), *MachineID);
}
```

---

### 6-3. UE5 C++ — PlayerController

```cpp
void ADigitalTwinPlayerController::SetupInputComponent()
{
    Super::SetupInputComponent();
    InputComponent->BindKey(EKeys::LeftMouseButton,  IE_Pressed,
        this, &ADigitalTwinPlayerController::OnLeftClick);
    InputComponent->BindKey(EKeys::RightMouseButton, IE_Pressed,
        this, &ADigitalTwinPlayerController::OnRightMousePressed);
    InputComponent->BindKey(EKeys::RightMouseButton, IE_Released,
        this, &ADigitalTwinPlayerController::OnRightMouseReleased);
    InputComponent->BindAxis("Turn",   this, &ADigitalTwinPlayerController::OnMouseX);
    InputComponent->BindAxis("LookUp", this, &ADigitalTwinPlayerController::OnMouseY);
}

void ADigitalTwinPlayerController::OnMouseX(float Value)
{ if (bRightMouseDown) AddYawInput(Value); }
void ADigitalTwinPlayerController::OnMouseY(float Value)
{ if (bRightMouseDown) AddPitchInput(Value); }
```

#### 카메라 위치를 Supabase로 전송 (미니맵 동기화)

```cpp
void ADigitalTwinPlayerController::SendCameraState()
{
    const APawn* P = GetPawn();
    if (!P) return;

    const FString Body = FString::Printf(
        TEXT("{\"x\":%.0f,\"y\":%.0f,\"yaw\":%.1f}"),
        P->GetActorLocation().X, P->GetActorLocation().Y, GetControlRotation().Yaw);

    FHttpRequestRef Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(SupabaseUrl + TEXT("/rest/v1/camera_state?id=eq.current"));
    Req->SetVerb(TEXT("PATCH"));
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetHeader(TEXT("apikey"), SupabaseAnonKey);
    Req->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + SupabaseAnonKey);
    Req->SetContentAsString(Body);
    Req->ProcessRequest();
}
```

---

### 6-4. Next.js 웹 대시보드

#### 설비 선택 → Supabase 릴레이 → UE 카메라 이동

```typescript
const selectMachine = useCallback((m: MachineData | null) => {
  setSelectedMachine(m);

  // upsert: 행이 없으면 INSERT, 있으면 UPDATE
  // (update 단독은 행이 없을 때 오류 없이 무음 실패)
  supabase.from('factory_selection')
    .upsert({ id: 'current', machine_id: m?.id ?? null }, { onConflict: 'id' })
    .then(({ error }) => {
      if (error) console.error('[DigitalTwin] factory_selection 업데이트 실패:', error);
      else console.log('[DigitalTwin] factory_selection →', m?.id ?? null);
    });

  // PS2 보조 경로 — iframe postMessage
  if (m && iframeRef.current?.contentWindow)
    iframeRef.current.contentWindow.postMessage({ type: 'machineSelect', id: m.id }, '*');
}, []);
```

#### Supabase Realtime 구독 (센서 데이터)

```typescript
useEffect(() => {
  fetchMachines();

  const ch = supabase.channel('rt-factory')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'factory_machines' },
      payload => {
        const next = payload.new as Partial<MachineData>;
        if (!next?.id) return;
        setMachines(prev => prev.map(m => m.id === next.id ? { ...m, ...next } : m));
        setSelectedMachine(prev =>
          prev?.id === next.id ? { ...prev, ...next } as MachineData : prev);
      })
    .subscribe(s => {
      setOnline(s === 'SUBSCRIBED');
      if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT')
        setLog('실시간 채널 재연결 시도 중...');
    });

  return () => { supabase.removeChannel(ch); };
}, []);
```

#### 미니맵 컴포넌트 (SVG)

```typescript
const FACTORY = { minX: -5000, maxX: 5000, minY: -5000, maxY: 5000 }; // UE cm 단위

function Minimap({ cam, machines, selectedId }) {
  const W = 160, H = 110, PAD = 10;
  const norm = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  // UE X(북) → SVG Y(위), UE Y(동) → SVG X(오른쪽)
  const toSvg = (wx, wy) => ({
    x: PAD + norm(wy, FACTORY.minY, FACTORY.maxY) * (W - PAD * 2),
    y: PAD + (1 - norm(wx, FACTORY.minX, FACTORY.maxX)) * (H - PAD * 2),
  });
  const c = toSvg(cam.x, cam.y);
  const rad = (cam.yaw * Math.PI) / 180, sz = 7;
  const tip = { x: c.x + Math.sin(rad) * sz,             y: c.y - Math.cos(rad) * sz };
  const lft = { x: c.x + Math.sin(rad - 2.35) * sz * .5, y: c.y - Math.cos(rad - 2.35) * sz * .5 };
  const rgt = { x: c.x + Math.sin(rad + 2.35) * sz * .5, y: c.y - Math.cos(rad + 2.35) * sz * .5 };

  return (
    <svg width={W} height={H}>
      <rect x={PAD} y={PAD} width={W-PAD*2} height={H-PAD*2} fill="rgba(30,58,95,0.3)" />
      {machines.map((m, i) => {
        const a = (i / machines.length) * Math.PI * 2, r = 30;
        return <circle key={m.id}
          cx={PAD + (W-PAD*2)/2 + Math.cos(a)*r}
          cy={PAD + (H-PAD*2)/2 + Math.sin(a)*r}
          r={m.id === selectedId ? 5 : 3}
          fill={m.id === selectedId ? '#3b82f6' : '#334155'} />;
      })}
      <polygon points={`${tip.x},${tip.y} ${lft.x},${lft.y} ${rgt.x},${rgt.y}`}
               fill="#facc15" />
    </svg>
  );
}
```

---

### 6-5. Pixel Streaming 연동

#### SignallingWebServer 실행

```bash
git clone --branch UE5.6 \
  https://github.com/EpicGamesExt/PixelStreamingInfrastructure.git
cd PixelStreamingInfrastructure/SignallingWebServer/platform_scripts/cmd
setup.bat && start.bat  # HTTP :80 / Streamer WS :8888
```

#### UE5 실행 커맨드

```bat
"C:\Build\FactoryEnvironmentCollect.exe" ^
  -PixelStreamingURL=ws://127.0.0.1:8888 ^
  -RenderOffScreen -Unattended -AudioMixer ^
  -ForceRes -ResX=1920 -ResY=1080
```

#### `player.html` — postMessage 리스너 추가

`</body>` 직전에 삽입:

```html
<script>
window.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'machineSelect') return;
  var id = e.data.id;
  function tryEmit() {
    if (window.pixelStreaming && window.pixelStreaming.emitUIInteraction)
      window.pixelStreaming.emitUIInteraction({ MachineSelect: id });
    else
      setTimeout(tryEmit, 200);
  }
  tryEmit();
});
</script>
```

#### Next.js iframe

```typescript
// .env.local
NEXT_PUBLIC_PIXEL_STREAM_URL=http://127.0.0.1

// page.tsx
<iframe
  ref={iframeRef}
  src={`${process.env.NEXT_PUBLIC_PIXEL_STREAM_URL}?HoveringMouse=true`}
  style={{ width: '100%', height: '100%', border: 'none' }}
  allow="autoplay; fullscreen; xr-spatial-tracking"
/>
```

---

## 7. 트러블슈팅

---

### 🔴 [핵심] 웹 버튼 클릭이 UE 카메라 이동으로 이어지지 않는 문제

**증상:** 웹 UI에서 설비 버튼을 클릭해도 UE5 뷰포트 카메라가 전혀 움직이지 않음.

이 문제는 서로 다른 레이어에서 연쇄 발생한 **복합 장애**였습니다.

---

#### 원인 1: 이기종 호스트 간 localhost 통신 불가 (근본 원인)

초기 설계는 UE5(Windows)가 Next.js API를 직접 폴링하는 방식이었습니다.

```
// UE(Windows) → 아래 URL로 GET 시도 → Connection Refused
http://localhost:3000/api/machine-select

이유: UE는 Windows 머신, Next.js는 Linux Cloud Workstation
     → 서로 다른 호스트의 localhost는 연결 불가
```

UE Output Log:
```
LogHttp: Warning: Completed request with URL 'http://localhost:3000/api/machine-select'
         completed with reason 'ConnectionError'
```

**해결:** 두 머신이 모두 접근 가능한 **Supabase를 중계 서버**로 사용

```
기존: 웹 → Next.js API → (❌ localhost) → UE
변경: 웹 → Supabase factory_selection → (✅ 퍼블릭 인터넷) → UE
```

---

#### 원인 2: Supabase RLS 쓰기 차단

```javascript
// 브라우저 콘솔 오류
[DigitalTwin] factory_selection 업데이트 실패: {
  code: "42501",
  message: "new row violates row-level security policy"
}
```

Supabase는 신규 테이블에 기본적으로 RLS를 활성화하며, anon 키로는 쓰기가 차단됩니다.

**해결:**

```sql
ALTER TABLE factory_selection DISABLE ROW LEVEL SECURITY;
```

---

#### 원인 3: `UPDATE` 무음 실패 — 초기 행 없음

RLS 해결 후에도 여전히 카메라가 움직이지 않았습니다.  
`UPDATE` 는 대상 행이 없으면 **0 rows affected, 오류 없이 종료**됩니다.

```typescript
// 문제 — 'current' 행이 없으면 조용히 실패
supabase.from('factory_selection')
  .update({ machine_id: 'cnc-01' })
  .eq('id', 'current')
```

UE 폴링 결과:
```
[DigitalTwin] 선택폴링 JSON 파싱 실패: []
// Supabase 응답: [] — 행이 없어 빈 배열 반환
```

**해결 1:** 초기 행 삽입

```sql
INSERT INTO factory_selection (id, machine_id) VALUES ('current', null);
```

**해결 2:** `update` → `upsert` 로 변경

```typescript
supabase.from('factory_selection')
  .upsert({ id: 'current', machine_id: 'cnc-01' }, { onConflict: 'id' })
```

---

#### 최종 동작 흐름 (해결 후)

```
1. 웹에서 'CNC 머시닝 센터' 클릭
   ↓
2. supabase.upsert({ id: 'current', machine_id: 'cnc-01' })
   콘솔: [DigitalTwin] factory_selection → cnc-01  ✅
   ↓
3. UE PollSelectionState() 1초 주기 실행
   GET factory_selection?id=eq.current → [{"machine_id":"cnc-01"}]
   ↓
4. machine_id == MachineID → MoveViewportToCamera()
   UE Log: [DigitalTwin] cnc-01 → 즉시 이동  ✅
   ↓
5. UE5 카메라가 CNC 설비 위치로 이동
```

---

### 🟡 카메라 이동 후 뷰 흔들림

**증상:** 설비 위치 이동 직후 뷰가 순간적으로 끊기거나 흔들림.

| 시도 | 결과 |
|---|---|
| `SetViewTargetWithBlend(1.0s)` 후 즉시 전환 | 블렌드 미완 시점 전환으로 끊김 |
| Pawn 선이동 후 블렌드 | 출발점=목적지 → 블렌드 효과 없음 |
| `SetViewTargetWithBlend(Pawn, 0.1s)` | 미세 개선, 완전 해결 아님 |

**최종 해결:** 블렌드 제거, Pawn 즉시 이동

```cpp
Pawn->SetActorLocationAndRotation(
    MachineCamera->GetActorLocation(),
    MachineCamera->GetActorRotation());
PC->SetControlRotation(MachineCamera->GetActorRotation());
```

---

### 🟡 Pixel Streaming 2 C++ API 버전 오류

**증상:**

```
error: 'GetPixelStreaming2Delegates' is not a member of 'UPixelStreaming2Delegates'
error: 'OnInputReceived' is not a member of 'UPixelStreaming2Delegates'
```

**원인:** UE 5.6/5.7 PS2 API가 기존 문서·예제와 달라 델리게이트 이름이 버전마다 상이.

**해결:** C++ PS2 API 포기 → Supabase 릴레이 방식으로 전환. Build.cs에서 존재하지 않는 모듈 제거.

```csharp
// 제거 (UE 5.6/5.7에 없음)
PrivateDependencyModuleNames.Add("PixelStreaming2Input");
```

---

### 🟡 Pixel Streaming pointer lock 히트 감지 실패

**증상:** PS2 스트리밍 중 기계 클릭 → `GetHitResultUnderCursor` 항상 실패.

**원인:** pointer lock 상태에서 브라우저는 마우스 **절대 위치** 대신 **델타** 만 전송.  
`GetHitResultUnderCursor` 는 절대 위치 필요 → 항상 (0,0) 참조.

**해결:** Turn/LookUp 델타를 누적해 가상 절대 좌표 추적.

```cpp
float TrackedMouseX = 0.f, TrackedMouseY = 0.f;

void ADigitalTwinPlayerController::OnMouseX(float Value)
{
    if (bRightMouseDown) AddYawInput(Value);
    TrackedMouseX = FMath::Clamp(TrackedMouseX + Value, 0.f,
        (float)GSystemResolution.ResX);
}

void ADigitalTwinPlayerController::OnLeftClick()
{
    FHitResult Hit;
    GetHitResultAtScreenPosition(
        FVector2D(TrackedMouseX, TrackedMouseY), ECC_Visibility, false, Hit);
    if (!Hit.bBlockingHit) return;
    AMachineActor* Machine = Cast<AMachineActor>(Hit.GetActor());
    if (Machine) SendMachineClickMessage(Machine->MachineID);
}
```

---

### 🟡 XR Permissions Policy 경고

**증상:** `Permissions policy violation: xr-spatial-tracking is not allowed`

**원인:** PS2 라이브러리가 WebXR 지원 확인 → iframe 환경에서 권한 없음.  
**영향:** 기능 무관, 경고만 출력.  
**억제:** `<iframe allow="autoplay; fullscreen; xr-spatial-tracking" ...>`

---

### 🟡 `StatusColor` 파라미터 이름 불일치

**증상:** DB 상태 변경에도 3D 메시 색상 불변.  
**원인:** `SetVectorParameterValue` 에서 이름이 한 글자라도 다르면 조용히 무시.  
**확인:** UE 머티리얼 에디터 → 파라미터 Name 필드가 정확히 `StatusColor` 인지 확인.

---

### 🟡 `MachineCamera` 미설정

**증상:** `[DigitalTwin] cnc-01: MachineCamera 미설정`  
**해결:** 각 MachineActor Details 패널 → **Machine Camera** 필드에 전용 CameraActor 드래그 연결.

---

## 8. 개선사항 및 향후 계획

### 단기

| 항목 | 설명 | 우선순위 |
|---|---|---|
| 카메라 부드러운 이동 | Lerp 기반 이동 — 즉시 점프 방식 대체 | 높음 |
| 설비 위치 저장 | `map_x`, `map_y` 추가 → 미니맵 정확 배치 | 높음 |
| `factory_selection` Realtime 전환 | 1초 폴링 → Realtime 구독으로 지연 제거 | 중간 |
| `FactoryDataManager` | Bulk 폴링으로 통합 — N대도 요청 1회 | 중간 |

### 중기

| 항목 | 설명 |
|---|---|
| 다중 사용자 | 사용자별 세션 처리 |
| 데이터 히스토리 | 센서 시계열 저장 + 그래프 |
| 알림 시스템 | 오류 발생 시 이메일/Slack |
| 인증 | Supabase Auth + 역할 기반 접근 |

### 장기

| 항목 | 설명 |
|---|---|
| 모바일 지원 | 터치 기반 카메라 제어 |
| 예측 유지보수 | ML 모델 연동 |
| AR 오버레이 | 실제 공장 영상 위 센서 데이터 |
| Edge Function | anon 직접 쓰기 차단, 서버 경유 쓰기 |

---

## 9. 실행 방법

### 환경 변수 (`.env.local`)

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
NEXT_PUBLIC_PIXEL_STREAM_URL=http://<signalling-server-ip>
```

### 웹 대시보드

```bash
npm install
npm run dev   # http://localhost:3000
```

### UE5 Pixel Streaming

```bash
# 1. SignallingWebServer (최초 1회 clone 필요)
git clone --branch UE5.6 https://github.com/EpicGamesExt/PixelStreamingInfrastructure.git
cd PixelStreamingInfrastructure/SignallingWebServer/platform_scripts/cmd
setup.bat && start.bat

# 2. UE5 패키징 빌드 실행
FactoryEnvironmentCollect.exe -PixelStreamingURL=ws://127.0.0.1:8888 -RenderOffScreen
```

### UE5 에디터 체크리스트

| 항목 | 값 |
|---|---|
| Default GameMode | `BP_DigitalTwinGameMode` |
| 각 MachineActor → Machine ID | `cnc-01` / `robot-02` / `conveyor-03` |
| 각 MachineActor → Machine Camera | 전용 CameraActor 드래그 연결 |
| 머티리얼 → `StatusColor` | Emissive Color 포트에 연결 (Base Color 아님!) |
| Collision Presets | `BlockAll` (기본 NoCollision 이면 클릭 감지 안 됨) |

### 빠른 오류 대응표

| 증상 | 원인 | 해결 |
|---|---|---|
| 웹은 갱신되나 3D 색상 안 변함 | `StatusColor` 이름 불일치 | 머티리얼 에디터 확인 |
| DB 변경해도 대시보드 무응답 | Realtime Publication 미등록 | `ALTER PUBLICATION supabase_realtime ADD TABLE ...` |
| anon UPDATE 거부 | RLS 활성화 / 정책 없음 | `DISABLE ROW LEVEL SECURITY` 또는 정책 추가 |
| 웹 클릭해도 UE 카메라 안 움직임 | localhost 불가 / `current` 행 없음 | Supabase 릴레이 + 초기 행 삽입 |
| 스트림 검은 화면 | 구버전 `-PixelStreamingIP` 인수 | `-PixelStreamingURL` 로 교체 |
| WASD 이동 안 됨 | DefaultInput.ini 미적용 | Project Settings → Input Axis Mappings 추가 |

---

## 라이선스

MIT License
