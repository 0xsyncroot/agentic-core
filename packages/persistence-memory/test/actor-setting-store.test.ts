import { actorSettingConformance } from "../../contracts/test/actor-setting-store-conformance.js";
import { InMemoryActorSettingStore } from "@0xsyncroot/persistence-memory";

actorSettingConformance("in-memory", () => new InMemoryActorSettingStore());
