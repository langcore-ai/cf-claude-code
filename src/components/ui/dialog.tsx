"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/** 对话框根组件 */
const Dialog = DialogPrimitive.Root;
/** 对话框触发器 */
const DialogTrigger = DialogPrimitive.Trigger;
/** 对话框传送门 */
const DialogPortal = DialogPrimitive.Portal;
/** 对话框关闭按钮 */
const DialogClose = DialogPrimitive.Close;

/**
 * 对话框遮罩层。
 * @param props 遮罩层属性
 * @returns 遮罩层节点
 */
function DialogOverlay({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			className={cn(
				"fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * 对话框内容容器。
 * @param props 内容属性
 * @returns 内容节点
 */
function DialogContent({
	className,
	children,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 w-[min(92vw,680px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-2xl",
					className,
				)}
				{...props}
			>
				{children}
				<DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
					<span className="sr-only">Close</span>
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

/**
 * 对话框头部。
 * @param props 容器属性
 * @returns 头部节点
 */
function DialogHeader({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col gap-1.5 text-left", className)}
			{...props}
		/>
	);
}

/**
 * 对话框底部。
 * @param props 容器属性
 * @returns 底部节点
 */
function DialogFooter({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("mt-4 flex items-center justify-end gap-2", className)}
			{...props}
		/>
	);
}

/**
 * 对话框标题。
 * @param props 标题属性
 * @returns 标题节点
 */
function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			className={cn("text-base font-semibold text-foreground", className)}
			{...props}
		/>
	);
}

/**
 * 对话框说明文案。
 * @param props 说明属性
 * @returns 说明节点
 */
function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
