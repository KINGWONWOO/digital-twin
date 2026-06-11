#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Camera/CameraActor.h"
#include "MachineActor.generated.h"

class FJsonObject;
class ACameraActor;

UCLASS()
class FACTORYENVIRONMENTCOLLECT_API AMachineActor : public AActor
{
	GENERATED_BODY()
public:
	AMachineActor();

protected:
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaTime) override;

public:
	// Supabase id 컬럼과 1:1 매핑 (에디터에서 각 액터마다 입력)
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Digital Twin Config")
	FString MachineID;

	// 이 기계를 비추는 전용 카메라 (에디터에서 레벨 내 CameraActor 연결)
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Digital Twin Config")
	ACameraActor* MachineCamera = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Digital Twin Components")
	class UMeshComponent* MeshComponent;

	UPROPERTY(BlueprintReadOnly, Category = "Digital Twin Materials")
	UMaterialInstanceDynamic* DynamicMaterialInstance;

	void FetchMachineStatus();
	void OnStatusResponseReceived(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful);

	// PS 데이터 채널로 선택 수신 시 PlayerController가 직접 호출
	void MoveViewportToCamera();

	bool bIsSelected = false;

private:
	void PollSelectionState();
	void OnSelectionResponseReceived(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful);
	void FinishCameraTransition();

	FString CurrentStatus = TEXT("normal");

	FTimerHandle PollingTimerHandle;
	FTimerHandle SelectionTimerHandle;
	FTimerHandle CameraBlendTimer;

	float   CurrentInterval = 2.0f;
	int32   ConsecutiveFailures = 0;

	FString SupabaseUrl;
	FString SupabaseAnonKey;
	float   MaxInterval = 30.0f;
	double  MaxTemperature = 85.0;
	double  MaxVibration = 5.0;
};
