#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "DigitalTwinGameMode.generated.h"

UCLASS()
class FACTORYENVIRONMENTCOLLECT_API ADigitalTwinGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ADigitalTwinGameMode();

protected:
	// 플레이어(Pixel Streaming 클라이언트 포함) 접속 시 카메라 지정
	virtual void PostLogin(APlayerController* NewPlayer) override;
};
