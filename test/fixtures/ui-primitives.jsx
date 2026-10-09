import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Combobox, Dialog, FormField, Menu, Tabs, ToastRegion, fieldDescriptionIds } from "../../scaffold/minimal-web/frontend/src/ui";

function Fixture() {
  const [refreshes, setRefreshes] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("write");
  const [tab, setTab] = useState("overview");
  const [messages, setMessages] = useState([
    { id: "saved", message: "已保存", dismissLabel: "关闭成功提示" },
    { id: "error", message: "保存失败", tone: "error", dismissLabel: "关闭错误提示" },
  ]);
  const options = [{ value: "read", label: "只读" }, { value: "write", label: "编辑" }];
  return <>
    <h1>UI primitives fixture</h1>
    <Button onClick={() => setRefreshes(value => value + 1)}>刷新视图</Button>
    <p id="refresh-count">{refreshes}</p>
    <Combobox label="角色" options={options} />
    <Combobox label="角色" options={options} />
    <Combobox label="状态" options={options} value={status} onChange={event => setStatus(event.target.value)} />
    <Combobox id="explicit-choice" label="权限" options={options} />
    <Button onClick={() => setOpen(true)}>打开编辑器</Button>
    <Dialog open={open} title="编辑项目" description="Current editor session" closeLabel="关闭编辑器" onOpenChange={setOpen}
      actions={<Button onClick={() => setOpen(false)}>完成编辑</Button>}>
      <input aria-label="项目名称" />
    </Dialog>
    <Menu triggerLabel="项目操作" items={[
      { id: "rename", label: "重命名", onSelect: () => setSelected("rename") },
      { id: "archive", label: "归档", disabled: true, onSelect: () => setSelected("archive") },
      { id: "delete", label: "删除", onSelect: () => setSelected("delete") },
    ]} />
    <p id="selected-action">{selected}</p>
    <Tabs label="视图" activeId={tab} onChange={setTab} items={[
      { id: "overview", label: "概览", panel: "概览内容" },
      { id: "disabled", label: "历史", panel: "历史内容", disabled: true },
      { id: "settings", label: "设置", panel: "设置内容" },
    ]} />
    <FormField id="name" label="名称" error="名称不能为空">
      <input id="name" aria-describedby={fieldDescriptionIds("name", { error: true })} />
    </FormField>
    <ToastRegion label="消息" messages={messages} onDismiss={id => setMessages(current => current.filter(message => message.id !== id))} />
  </>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
