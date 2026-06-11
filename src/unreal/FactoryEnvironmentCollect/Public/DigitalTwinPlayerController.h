#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "DigitalTwinPlayerController.generated.h"

UCLASS()
class FACTORYENVIRONMENTCOLLECT_API ADigitalTwinPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	ADigitalTwinPlayerController();

protected:
	virtual void BeginPlay() override;
	virtual void SetupInputComponent() override;

	// Blueprint에서 PS2 "On Input Event"와 연결
	UFUNCTION(BlueprintCallable, Category = "DigitalTwin")
	void HandlePixelStreamingInput(const FString& PlayerId, const FString& Descriptor);

private:
	void OnLeftClick();
	void OnRightMousePressed();
	void OnRightMouseReleased();
	void OnMouseX(float Value);
	void OnMouseY(float Value);
	void SendMachineClickMessage(const FString& MachineID);
	void SendCameraState();

	bool bRightMouseDown;
	FString DashboardClickUrl;
	FString SupabaseUrl;
	FString SupabaseAnonKey;
	FTimerHandle CameraStateTimer;
};
