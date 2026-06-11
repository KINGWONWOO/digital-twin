#include "MachineActor.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Components/MeshComponent.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"

AMachineActor::AMachineActor()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("DefaultRoot"));
}

void AMachineActor::BeginPlay()
{
	Super::BeginPlay();

	SupabaseUrl     = TEXT("https://ncibtuxmpfqjdzoqyqrw.supabase.co");
	SupabaseAnonKey = TEXT("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jaWJ0dXhtcGZxamR6b3F5cXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNDg4MTgsImV4cCI6MjA5NjYyNDgxOH0.W8Y96fyzPlNqgnZzNtidwpSjLNuln8VP-5wYNHcbLyc");
	CurrentInterval = 2.0f;
	MaxInterval     = 30.0f;
	MaxTemperature  = 85.0;
	MaxVibration    = 5.0;

	MeshComponent = FindComponentByClass<UMeshComponent>();
	if (MeshComponent && MeshComponent->GetMaterial(0))
	{
		DynamicMaterialInstance = MeshComponent->CreateDynamicMaterialInstance(0);
	}
	else
	{
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] %s: 슬롯 0에 머티리얼 없음 — 색상 제어 불가"), *MachineID);
	}

	if (!MachineID.IsEmpty())
	{
		GetWorldTimerManager().SetTimer(PollingTimerHandle,   this, &AMachineActor::FetchMachineStatus, CurrentInterval, true);
		GetWorldTimerManager().SetTimer(SelectionTimerHandle, this, &AMachineActor::PollSelectionState,  1.0f, true);
	}
}

// ────────────────────────────────────────────────────────────────
//  Tick: StatusColor 파라미터를 상태/선택 여부에 따라 실시간 갱신
//
//  머티리얼 설정 가정: Base Color = 에디터 지정 원본 텍스처/색상
//                      StatusColor 노드 → Emissive Color (가산 발광)
//  StatusColor = (0,0,0) 일 때 원본 색상만 표시, 값이 있을 때 발광
// ────────────────────────────────────────────────────────────────
void AMachineActor::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);
	if (!DynamicMaterialInstance) return;

	const float T = GetWorld()->GetTimeSeconds();
	FLinearColor Emissive = FLinearColor(0.f, 0.f, 0.f); // 기본: 발광 없음

	if (CurrentStatus == TEXT("error"))
	{
		// 빠른 빨간 깜빡임 (5Hz)
		const float Blink = FMath::Abs(FMath::Sin(T * 5.0f * PI));
		Emissive = FLinearColor(Blink * 3.0f, 0.f, 0.f);
	}
	else if (CurrentStatus == TEXT("warning"))
	{
		// 느린 주황 깜빡임 (1.5Hz)
		const float Blink = 0.5f + 0.5f * FMath::Sin(T * 1.5f * PI);
		Emissive = FLinearColor(Blink * 2.0f, Blink * 0.8f, 0.f);
	}
	else if (bIsSelected)
	{
		// 선택 시 부드러운 파란 펄스
		const float Pulse = 0.6f + 0.4f * FMath::Sin(T * 2.0f);
		Emissive = FLinearColor(0.f, Pulse * 0.5f, Pulse * 1.8f);
	}
	// normal + 미선택 → Emissive = (0,0,0), 원본 색상 유지

	DynamicMaterialInstance->SetVectorParameterValue(TEXT("StatusColor"), Emissive);
}

// ── Supabase 폴링 ──────────────────────────────────────────────

void AMachineActor::FetchMachineStatus()
{
	FHttpRequestRef Request = FHttpModule::Get().CreateRequest();
	Request->OnProcessRequestComplete().BindUObject(this, &AMachineActor::OnStatusResponseReceived);
	Request->SetURL(FString::Printf(TEXT("%s/rest/v1/factory_machines?id=eq.%s&select=*"), *SupabaseUrl, *MachineID));
	Request->SetVerb(TEXT("GET"));
	Request->SetHeader(TEXT("apikey"), SupabaseAnonKey);
	Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *SupabaseAnonKey));
	Request->SetTimeout(5.0f);
	Request->ProcessRequest();
}

void AMachineActor::OnStatusResponseReceived(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful)
{
	if (!bWasSuccessful || !Response.IsValid())
	{
		ConsecutiveFailures++;
		CurrentInterval = FMath::Min(CurrentInterval * 2.0f, MaxInterval);
		GetWorldTimerManager().SetTimer(PollingTimerHandle, this, &AMachineActor::FetchMachineStatus, CurrentInterval, true);
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] %s HTTP 실패 (%d회) → %.1fs 후 재시도"), *MachineID, ConsecutiveFailures, CurrentInterval);
		return;
	}
	if (Response->GetResponseCode() != 200)
	{
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] 서버 오류: %d"), Response->GetResponseCode());
		return;
	}
	if (ConsecutiveFailures > 0)
	{
		ConsecutiveFailures = 0;
		CurrentInterval = 2.0f;
		GetWorldTimerManager().SetTimer(PollingTimerHandle, this, &AMachineActor::FetchMachineStatus, CurrentInterval, true);
	}

	TArray<TSharedPtr<FJsonValue>> JsonArray;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
	if (!FJsonSerializer::Deserialize(Reader, JsonArray) || JsonArray.Num() == 0) return;

	const TSharedPtr<FJsonObject> Obj = JsonArray[0]->AsObject();
	if (!Obj.IsValid()) return;

	FString Status;
	double  Temperature = 0.0, Vibration = 0.0;
	Obj->TryGetStringField(TEXT("status"),       Status);
	Obj->TryGetNumberField(TEXT("temperature"),   Temperature);
	Obj->TryGetNumberField(TEXT("vibration_mms"), Vibration);

	// 데이터 기반 상태 결정 (status 필드 우선, 수치 초과 시 escalate)
	if (Status.Equals(TEXT("error"), ESearchCase::IgnoreCase))
		CurrentStatus = TEXT("error");
	else if (Status.Equals(TEXT("warning"), ESearchCase::IgnoreCase) || Temperature > MaxTemperature || Vibration > MaxVibration)
		CurrentStatus = TEXT("warning");
	else if (Status.Equals(TEXT("offline"), ESearchCase::IgnoreCase))
		CurrentStatus = TEXT("offline");
	else
		CurrentStatus = TEXT("normal");
}

// ── Supabase factory_selection 폴링 (1초 주기) ──────────────────

void AMachineActor::PollSelectionState()
{
	FHttpRequestRef Request = FHttpModule::Get().CreateRequest();
	Request->OnProcessRequestComplete().BindUObject(this, &AMachineActor::OnSelectionResponseReceived);
	Request->SetURL(FString::Printf(TEXT("%s/rest/v1/factory_selection?id=eq.current&select=machine_id"), *SupabaseUrl));
	Request->SetVerb(TEXT("GET"));
	Request->SetHeader(TEXT("apikey"), SupabaseAnonKey);
	Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *SupabaseAnonKey));
	Request->SetTimeout(3.0f);
	Request->ProcessRequest();
}

void AMachineActor::OnSelectionResponseReceived(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful)
{
	if (!bWasSuccessful || !Response.IsValid() || Response->GetResponseCode() != 200)
	{
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] %s 선택폴링 실패: code=%d"), *MachineID,
			Response.IsValid() ? Response->GetResponseCode() : -1);
		return;
	}

	TArray<TSharedPtr<FJsonValue>> JsonArray;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
	if (!FJsonSerializer::Deserialize(Reader, JsonArray) || JsonArray.Num() == 0)
	{
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] %s 선택폴링 JSON 파싱 실패: %s"), *MachineID, *Response->GetContentAsString());
		return;
	}

	const TSharedPtr<FJsonObject> Obj = JsonArray[0]->AsObject();
	if (!Obj.IsValid()) return;

	FString SelId;
	Obj->TryGetStringField(TEXT("machine_id"), SelId);

	UE_LOG(LogTemp, Log, TEXT("[DigitalTwin] %s 선택폴링 OK: machine_id=%s"), *MachineID, *SelId);

	const bool bNewSelected = (SelId == MachineID);
	if (bNewSelected && !bIsSelected)
	{
		MoveViewportToCamera();
	}
	bIsSelected = bNewSelected;
}

void AMachineActor::MoveViewportToCamera()
{
	if (!MachineCamera)
	{
		UE_LOG(LogTemp, Warning, TEXT("[DigitalTwin] %s: MachineCamera 미설정"), *MachineID);
		return;
	}

	APlayerController* PC = GetWorld()->GetFirstPlayerController();
	if (!PC) return;

	APawn* Pawn = PC->GetPawn();
	if (!Pawn) return;

	Pawn->SetActorLocationAndRotation(
		MachineCamera->GetActorLocation(),
		MachineCamera->GetActorRotation()
	);
	PC->SetControlRotation(MachineCamera->GetActorRotation());

	UE_LOG(LogTemp, Log, TEXT("[DigitalTwin] %s → 즉시 이동"), *MachineID);
}

void AMachineActor::FinishCameraTransition()
{
	// 사용 안 함
}