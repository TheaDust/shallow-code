---
name: editable-grid
description: Implement spreadsheet cells, coordinates, ranges, formulas or editable data grids when selection, calculation, structural changes, formatting or export require coordinated state.
---

# 可编辑网格

根据需求建模表格、单元格、区域与坐标，区分对象身份、编辑文本、显示值和选中状态。ARIA grid/gridcell 与原生 table/cell 按需求选择；坐标名称、内容和状态分别表达，数值不自动成为控件名称。

公式文本与计算结果分别保存和读取。编辑、复制、排序、筛选和结构变化后，按需求更新受影响的引用、依赖、规则与选区。撤销重做及需显式刷新的派生结果遵守各自时机，失败保留最近有效状态。

创建筛选或区域操作时明确目标范围、列配置和有效数据边界，核对不同入口是否使用同一操作规则。保存、导出和刷新分别检查需求规定的结果；导出检查实际文件，并按合同区分公式与计算值。

条件格式等视觉要求检查实际计算样式、匹配与不匹配对象、选中状态和刷新结果。规则列表出现只是配置证据，完整结果还须检查相应单元格。检查准备状态、目标坐标、实际输入与每项明示结果。
