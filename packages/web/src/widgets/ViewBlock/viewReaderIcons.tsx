import { type ComponentType } from 'react'

import { IconBoard, type IconProps, IconView } from '../../core/Icons'

export type ViewReaderIcons = Readonly<Record<string, ComponentType<IconProps>>>

export const VIEW_READER_ICONS: ViewReaderIcons = Object.freeze({ board: IconBoard })

export const ViewTypeIcon = ({ viewType, ...props }: IconProps & { viewType: string }) => {
  const Icon = VIEW_READER_ICONS[viewType] ?? IconView

  return <Icon {...props} />
}
