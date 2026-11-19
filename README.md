# 河道巡查叙述的方位解释与补核计划

reaches 是有向岸段，可进入位置用 entry 表示。landmarks 把俗名和河网节点对应起来。handovers 保存巡查队交接原话。patrol 给出巡规定义和临时入场限制。flowNotes 保存值班采用的流向和班组口称。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
