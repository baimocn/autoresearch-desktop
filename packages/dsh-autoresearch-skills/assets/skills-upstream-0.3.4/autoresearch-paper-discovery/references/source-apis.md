# 公开检索接口与证据边界

本页只记录会影响检索正确性的接口事实。调用前仍需查看当前官方文档、服务条款和限流状态；接口返回是候选发现证据，不是论文正确性、源码许可或可复现性的证明。

## arXiv

- 官方 API 返回 Atom 1.0；查询入口使用 `search_query` 或 `id_list`，以 `start` 和 `max_results` 分页。
- 记录 entry 的 arXiv ID、版本、`published`、`updated`、标题、作者、摘要、类别及 PDF/abstract 链接。去重时 canonical arXiv ID 去掉 URL 包装和版本后缀，但账本保留实际阅读版本。
- 官方手册建议连续请求之间等待 3 秒；相同查询应缓存，不进行高频轮询。超过常规小批量时先收窄查询，批量获取遵循 arXiv 给出的专用方式。
- 来源：[arXiv API User's Manual](https://info.arxiv.org/help/api/user-manual.html)、[arXiv API Terms of Use](https://info.arxiv.org/help/api/tou.html)

## OpenAlex

- Works 文本搜索使用 `/works?search=...`；搜索覆盖标题、摘要和全文索引。布尔、精确和语义搜索的含义不同，查询账本必须保存实际参数。
- 保留 OpenAlex work ID、DOI、primary location、publication date、版本/关联标识和代码线索。引用量和 relevance score 只用于排序，不作为通过门槛。
- 长查询应按官方要求拆分，并在客户端按 OpenAlex ID/外部 ID 合并；分页未完成时必须标记召回不完整。
- 来源：[OpenAlex Search](https://help.openalex.org/api/searching/)、[OpenAlex API Overview](https://help.openalex.org/api/)

## Semantic Scholar

- 普通检索使用 Academic Graph 的 `/graph/v1/paper/search`；已知标题可用 `/paper/search/match`，但最高匹配仍需用外部 ID 和原始页面确认。
- 详情和批量详情接口支持 Semantic Scholar paper ID，以及带前缀的 DOI、ARXIV、CorpusId 等标识。请求 `externalIds`、`url`、`year`、`publicationDate`、`openAccessPdf`、`authors` 等明确字段，不依赖默认字段集合。
- 引用与参考网络用于扩展候选，不能把引用计数当作可复现性或难度证据。若使用 API key，只通过运行环境的受信配置传递，不写入账本或仓库。
- 来源：[Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/graph)、[API FAQ](https://www.semanticscholar.org/product/api/tutorial)

## GitHub 源码与许可证

- 从论文、作者主页或组织主页确认官方仓库关系；搜索命中或同名仓库不能单独证明来源。
- 固定仓库 URL 和 commit/tag。记录默认分支之外，还要确认实际实验对应的 revision、子模块、LFS 文件、release artifact 和外部模型/数据依赖。
- 检查仓库根及相关子目录的许可证文件。GitHub license API 可作为定位辅助，但许可证文本和适用范围才是证据；GitHub 明确说明，没有许可证时默认版权法适用，不能推断可以复制、修改或再分发。
- 来源：[GitHub Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)、[GitHub REST API for licenses](https://docs.github.com/en/rest/licenses)

## 查询留痕

每个查询至少记录：`source`、`endpoint`、不含密钥的参数、UTC 时间、分页游标/范围、HTTP 状态、返回条数和原始响应文件哈希。遇到 `429`、超时、权限不足或解析错误时，保留失败状态并重试到预设上限；不得把失败页面当空结果。
