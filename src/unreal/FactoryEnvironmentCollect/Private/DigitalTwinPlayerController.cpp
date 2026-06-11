#include "DigitalTwinPlayerController.h"
#include "MachineActor.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "EngineUtils.h"

ADigitalTwinPlayerController::ADigitalTwinPlayerController()
	: bRightMouseDown(false)
{
	bShowMouseCursor = true;
}

void ADigitalTwinPlayerController::BeginPlay()
{
	Super::BeginPlay();

	FInputModeGameAndUI InputMode;
	InputMode.SetHideCursorDuringCapture(false);
	SetInputMode(InputMode);

	DashboardClickUrl = TEXT("http://localhost:3000/api/machine-click");
	SupabaseUrl       = TEXT("https://ncibtuxmpfqjdzoqyqrw.supabase.co");
	SupabaseAnonKey   = TEXT("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jaWJ0dXhtcGZxamR6b3F5cXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNDg4MTgsImV4cCI6MjA5NjYyNDgxOH0.W8Y96fyzPlNqgnZzNtidwpSjLNuln8VP-5wYNHcbLyc");

	GetWorldTimerManager().SetTimer(CameraStateTimer, this, &ADigitalTwinPlayerController::SendCameraState, 0.5f, true);
}

void ADigitalTwinPlayerController::SetupInputComponent()
{
	Super::SetupInputComponent();

	InputComponent->BindKey(EKeys::LeftMouseButton, IE_Pressed, this, &ADigitalTwinPlayerController::OnLeftClick);
	InputComponent->BindKey(EKeys::RightMouseButton, IE_Pressed, this, &ADigitalTwinPlayerController::OnRightMousePressed);
	InputComponent->BindKey(EKeys::RightMouseButton, IE_Released, this, &ADigitalTwinPlayerController::OnRightMouseReleased);

	InputComponent->BindAxis("Turn", this, &ADigitalTwinPlayerController::OnMouseX);
	InputComponent->BindAxis("LookUp", this, &ADigitalTwinPlayerController::OnMouseY);
}

void ADigitalTwinPlayerController::OnRightMousePressed()
{
	bRightMouseDown = true;
}

void ADigitalTwinPlayerController::OnRightMouseReleased()
{
	bRightMouseDown = false;
}

void ADigitalTwinPlayerController::OnMouseX(float Value)
{
	if (bRightMouseDown)
		AddYawInput(Value);
}

void ADigitalTwinPlayerController::OnMouseY(float Value)
{
	if (bRightMouseDown)
		AddPitchInput(Value);
}

void ADigitalTwinPlayerController::OnLeftClick()
{
	float MX, MY;
	if (!GetMousePosition(MX, MY)) return;

	FHitResult Hit;
	if (GetHitResultAtScreenPosition(FVector2D(MX, MY), ECC_Visibility, false, Hit))
	{
		AMachineActor* Machine = Cast<AMachineActor>(Hit.GetActor());
		if (Machine)
			SendMachineClickMessage(Machine->MachineID);
	}
}

void ADigitalTwinPlayerController::HandlePixelStreamingInput(const FString& PlayerId, const FString& Descriptor)
{
	TSharedPtr<FJsonObject> Json;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Descriptor);
	if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid()) return;

	FString MachineId;
	if (!Json->TryGetStringField(TEXT("MachineSelect"), MachineId) || MachineId.IsEmpty()) return;

	UE_LOG(LogTemp, Log, TEXT("[DigitalTwin] PS 메시지 수신: MachineSelect=%s"), *MachineId);

	for (TActorIterator<AMachineActor> It(GetWorld()); It; ++It)
	{
		It->bIsSelected = (It->MachineID == MachineId);
		if (It->MachineID == MachineId)
		{
			It->MoveViewportToCamera();
		}
	}
}

void ADigitalTwinPlayerController::SendCameraState()
{
	const APawn* P = GetPawn();
	if (!P) return;

	const FVector Loc = P->GetActorLocation();
	const float   Yaw = GetControlRotation().Yaw;

	const FString Body = FString::Printf(
		TEXT("{\"x\":%.0f,\"y\":%.0f,\"yaw\":%.1f}"), Loc.X, Loc.Y, Yaw);

	FHttpRequestRef Req = FHttpModule::Get().CreateRequest();
	Req->SetURL(SupabaseUrl + TEXT("/rest/v1/camera_state?id=eq.current"));
	Req->SetVerb(TEXT("PATCH"));
	Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Req->SetHeader(TEXT("apikey"),         SupabaseAnonKey);
	Req->SetHeader(TEXT("Authorization"),  TEXT("Bearer ") + SupabaseAnonKey);
	Req->SetContentAsString(Body);
	Req->ProcessRequest();
}

void ADigitalTwinPlayerController::SendMachineClickMessage(const FString& MachineID)
{
	FHttpRequestRef Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(DashboardClickUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(FString::Printf(TEXT("{\"id\":\"%s\"}"), *MachineID));
	Request->ProcessRequest();

	UE_LOG(LogTemp, Log, TEXT("[DigitalTwin] Machine clicked: %s"), *MachineID);
}
