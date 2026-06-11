#include "DigitalTwinGameMode.h"
#include "DigitalTwinCameraActor.h"
#include "DigitalTwinPlayerController.h"
#include "GameFramework/SpectatorPawn.h"
#include "Kismet/GameplayStatics.h"

ADigitalTwinGameMode::ADigitalTwinGameMode()
{
	DefaultPawnClass     = ASpectatorPawn::StaticClass();
	PlayerControllerClass = ADigitalTwinPlayerController::StaticClass();
}

void ADigitalTwinGameMode::PostLogin(APlayerController* NewPlayer)
{
	Super::PostLogin(NewPlayer);

	ADigitalTwinCameraActor* Cam = Cast<ADigitalTwinCameraActor>(
		UGameplayStatics::GetActorOfClass(GetWorld(), ADigitalTwinCameraActor::StaticClass()));

	if (!Cam)
	{
		UE_LOG(LogTemp, Error,
			TEXT("[DigitalTwin] ADigitalTwinCameraActor not found in level. Please place one."));
		return;
	}

	APawn* Pawn = NewPlayer->GetPawn();
	if (!Pawn) return;

	// CameraActor 위치/회전을 초기 위치로 사용하되, SpectatorPawn이 직접 카메라 역할
	// (SetViewTargetWithBlend 대신 폰을 이동시켜 자유 이동이 가능하게 함)
	Pawn->SetActorLocationAndRotation(Cam->GetActorLocation(), Cam->GetActorRotation());
	NewPlayer->SetControlRotation(Cam->GetActorRotation());
}
