import { PROGRESS_DIR_NAME } from "./progress-journal.js";
import { PROJECT_SPEC_FILENAME } from "./project-spec.js";

/**
 * 控制器在启动/输出目录顶层维护的元数据：它们不属于应用源码，但可以出现在空白
 * 模板或已有项目中。新增一类元数据时只改这份名单与下面的分类；所有判定点都从
 * 这里派生，controller-metadata.test.ts 会逐个站点验证整份名单。
 *
 * 分类决定各站点的行为：
 * - 已交付（TRACKED）：属于应用内容或用户自己的文件，正常拷贝、跟踪与打包；
 * - Git 路径排除（PATH_EXCLUDED）：保留在打包产物中，但通过 git 路径排除规则
 *   跳过（例如平台需要看到进度日志，因此不能写进 .gitignore）；
 * - 忽略（IGNORED）：不属于应用内容，写入应用忽略规则并从历史与副本中排除。
 */
export const GIT_METADATA_NAMES = [".git"] as const;
export const TRACKED_METADATA_NAMES = [".gitignore", "requirements", PROJECT_SPEC_FILENAME] as const;
export const PATH_EXCLUDED_METADATA_NAMES = [".arc", PROGRESS_DIR_NAME] as const;
export const IGNORED_METADATA_NAMES = [".requirements-agent"] as const;

/** 全部控制器元数据；「目录是否只包含元数据」判定使用。 */
export const CONTROLLER_METADATA_NAMES = [
  ...GIT_METADATA_NAMES,
  ...TRACKED_METADATA_NAMES,
  ...PATH_EXCLUDED_METADATA_NAMES,
  ...IGNORED_METADATA_NAMES,
] as const;

export const CONTROLLER_METADATA: ReadonlySet<string> = new Set(CONTROLLER_METADATA_NAMES);

/** 不属于应用内容、不进入应用历史或运行副本的元数据目录。 */
export const NON_APPLICATION_METADATA_NAMES = [
  ...GIT_METADATA_NAMES,
  ...PATH_EXCLUDED_METADATA_NAMES,
  ...IGNORED_METADATA_NAMES,
] as const;

export const NON_APPLICATION_METADATA: ReadonlySet<string> = new Set(NON_APPLICATION_METADATA_NAMES);

/**
 * git 路径排除（capture/restore/clean/patch）使用的元数据目录，不含 `.git`。
 * 被忽略的目录一并列入：忽略规则可能不存在（例如仓库自带的 .gitignore），
 * 路径排除保证它们仍不会进入历史或被清理。
 */
export const EXCLUDED_METADATA_NAMES = [
  ...PATH_EXCLUDED_METADATA_NAMES,
  ...IGNORED_METADATA_NAMES,
] as const;

/** 写入应用 `.gitignore` 与本地 exclude 的规则。 */
export const IGNORED_METADATA_RULES: readonly string[] = IGNORED_METADATA_NAMES.map(name => `${name}/`);

/** 顶层相对路径是否位于非应用元数据内。 */
export function isNonApplicationMetadataPath(path: string): boolean {
  return NON_APPLICATION_METADATA.has(path.replaceAll("\\", "/").split("/", 1)[0]);
}
