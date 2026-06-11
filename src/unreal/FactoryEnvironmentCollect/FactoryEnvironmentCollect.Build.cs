using UnrealBuildTool;

public class FactoryEnvironmentCollect : ModuleRules
{
	public FactoryEnvironmentCollect(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"HTTP",
			"Json",
			"CinematicCamera",  // ACineCameraActor
			"InputCore",        // EKeys
		});

		PrivateDependencyModuleNames.Add("PixelStreaming2");
	}
}
